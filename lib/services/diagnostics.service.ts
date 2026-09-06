/**
 * System diagnostics - OWNER and DEVELOPER only.
 *
 * What this screen is for: answering "is the problem the database, this
 * container, or my code?" without an SSH session and without a metrics stack.
 * It reports four things about the process serving the request - storage,
 * runtime, caches and request timings - and nothing that would be useful to an
 * attacker: no connection string, no credentials, no index definitions, no
 * document contents.
 *
 * DEGRADATION IS THE POINT. Managed MongoDB tiers restrict administrative
 * commands, and a diagnostics page that returns 500 when one of them is refused
 * is worse than useless - it fails exactly when somebody is trying to find out
 * what is wrong. So every command here is attempted, never assumed: a refusal
 * is logged, that section reports what it can, and the response is still a 200
 * with `connected` telling the honest story.
 */
import type { DiagnosticsDto } from '@hostel/shared';
import type { Prisma } from '@prisma/client';
import { cacheStats } from '../cache';
import { checkDatabaseConnection, prisma } from '../db/prisma';
import { env } from '../env';
import { logger } from '../http/logger';
import { timingSummary } from '../http/metrics';

/**
 * Enough headroom for any real deployment; a guard against a pathological
 * `listCollections` result turning a diagnostics page into hundreds of
 * `collStats` round trips.
 */
const MAX_COLLECTIONS_REPORTED = 60;

const BYTES_PER_MB = 1024 * 1024;

type RawDocument = Record<string, unknown>;

const isRecord = (value: unknown): value is RawDocument =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * MongoDB extended JSON: a 64-bit integer comes back as `{ "$numberLong": "…" }`
 * rather than as a number once it is large enough, and `$runCommandRaw` does not
 * collapse it. Storage sizes are exactly the values that get big.
 */
function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (isRecord(value)) {
    for (const key of ['$numberLong', '$numberInt', '$numberDouble', '$numberDecimal']) {
      if (key in value) return num(value[key]);
    }
  }
  return 0;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Run an admin command, or return null if the deployment will not allow it. */
async function tryCommand(command: Prisma.InputJsonObject): Promise<RawDocument | null> {
  try {
    const result = await prisma.$runCommandRaw(command);
    return isRecord(result) ? result : null;
  } catch (error) {
    logger.warn('Diagnostics command was refused', {
      command: Object.keys(command)[0] ?? 'unknown',
      error,
    });
    return null;
  }
}

/**
 * Collection names, from `listCollections`.
 *
 * `nameOnly` and `authorizedCollections` are both set: the first keeps the
 * reply small, the second lets the command succeed on a user that can read some
 * collections but is not a cluster administrator - which is the common shape of
 * an application user on a managed tier.
 */
async function listCollectionNames(): Promise<string[]> {
  const result = await tryCommand({
    listCollections: 1,
    nameOnly: true,
    authorizedCollections: true,
  });
  if (!result) return [];

  const cursor = isRecord(result.cursor) ? result.cursor : null;
  const batch = cursor && Array.isArray(cursor.firstBatch) ? cursor.firstBatch : [];

  return batch
    .map((entry) => (isRecord(entry) ? str(entry.name) : ''))
    .filter((name) => name.length > 0)
    .sort()
    .slice(0, MAX_COLLECTIONS_REPORTED);
}

type CollectionRow = DiagnosticsDto['database']['collections'][number];

/**
 * Per-collection storage.
 *
 * `sizeBytes` is documents *plus* indexes on disk, because the question an
 * operator is really asking is "how much of my cluster is this collection
 * using", and on an append-only trail like `audit_logs` the indexes are a large
 * share of the answer. It is the same basis as `database.storageBytes`, so the
 * rows sum to roughly the total.
 *
 * `collStats` is deprecated on newer servers and restricted on some tiers, so
 * a refusal falls back to a plain `count`: fewer numbers, still true, never an
 * error.
 */
async function collectionStats(name: string): Promise<CollectionRow> {
  const stats = await tryCommand({ collStats: name });
  if (stats) {
    return {
      name,
      documents: num(stats.count),
      indexes: num(stats.nindexes),
      sizeBytes: num(stats.storageSize) + num(stats.totalIndexSize),
    };
  }

  const counted = await tryCommand({ count: name });
  return {
    name,
    documents: counted ? num(counted.n) : 0,
    indexes: 0,
    sizeBytes: 0,
  };
}

async function readDatabase(): Promise<DiagnosticsDto['database']> {
  const stats = await tryCommand({ dbStats: 1 });
  // dbStats succeeding is itself proof of a live connection; only when it is
  // refused is it worth spending a ping to find out which failure this is.
  const connected = stats !== null ? true : await checkDatabaseConnection();

  const names = connected ? await listCollectionNames() : [];
  const collections = await Promise.all(names.map(collectionStats));

  const totalDocuments = stats
    ? num(stats.objects)
    : collections.reduce((sum, row) => sum + row.documents, 0);

  const storageBytes = stats
    ? num(stats.storageSize) + num(stats.indexSize)
    : collections.reduce((sum, row) => sum + row.sizeBytes, 0);

  return {
    connected,
    // The database name is not a secret - it is half of every log line already -
    // but the credentials in DATABASE_URL are, which is why this comes from the
    // server's own reply rather than from parsing the connection string.
    name: stats ? str(stats.db) : '',
    collections,
    totalDocuments,
    storageBytes,
  };
}

const toMb = (bytes: number): number => Math.round((bytes / BYTES_PER_MB) * 10) / 10;

function readRuntime(): DiagnosticsDto['runtime'] {
  const memory = process.memoryUsage();
  return {
    nodeVersion: process.version,
    environment: env().NODE_ENV,
    // On Lambda this is the age of the execution environment, not of the
    // deployment: a low number after a long quiet period means a cold start.
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: {
      rss: toMb(memory.rss),
      heapUsed: toMb(memory.heapUsed),
      heapTotal: toMb(memory.heapTotal),
    },
  };
}

/**
 * In-process cache statistics, straight from `lib/cache`.
 *
 * `CacheStat` there is declared to be exactly `DiagnosticsDto['caches'][number]`,
 * so this is a pass-through and the compiler is what keeps the two in step.
 * These counters are per container, like the timings below: on Lambda a low hit
 * rate right after a deploy is cold containers, not a broken cache.
 */
function readCaches(): DiagnosticsDto['caches'] {
  return cacheStats();
}

export async function collectDiagnostics(): Promise<DiagnosticsDto> {
  return {
    database: await readDatabase(),
    runtime: readRuntime(),
    caches: readCaches(),
    timings: timingSummary(),
    generatedAt: new Date().toISOString(),
  };
}
