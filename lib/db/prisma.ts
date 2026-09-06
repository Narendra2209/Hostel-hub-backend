/**
 * Prisma client singleton (MongoDB / Atlas).
 *
 * Lambda connection handling
 * --------------------------
 * A Lambda execution environment is reused across invocations, so the client is
 * cached on `globalThis` and its connection pool is opened lazily on the first
 * query, then reused for the life of the container. Without this, every
 * invocation would pay for a fresh SRV lookup and TLS handshake to Atlas, and a
 * burst of traffic would exhaust the cluster's connection limit.
 *
 * MongoDB's driver pools internally and there is no RDS-Proxy equivalent to put
 * in front of it, so the pool is sized per container (see `resolveMaxPoolSize`).
 *
 * Pool sizing
 * -----------
 * The whole cluster sees:
 *
 *     total connections = containers x maxPoolSize   (+1 monitoring socket per pool)
 *
 * against the tier's ceiling - M0 allows 500, M10 allows 1500. The right value
 * for `maxPoolSize` therefore depends entirely on the deployment SHAPE, because
 * the two shapes differ in what one container is doing at a time:
 *
 *  * Lambda. One execution environment handles ONE request at a time, so a
 *    container never needs more than a couple of sockets and the rest would be
 *    idle sockets parked on the cluster. What varies is the number of
 *    containers, which AWS scales with load and which is the term that can
 *    actually exhaust the cluster. 5 x 100 concurrent executions = 500, already
 *    at M0's ceiling, so 5 is the ceiling-aware choice and the reserved
 *    concurrency configured in the CDK stack is what really bounds it.
 *
 *  * A long-running server (docker, `next start`, ECS). ONE container serves
 *    every concurrent request, so it needs enough sockets to overlap the
 *    queries in flight, and the number of containers is a small, fixed, known
 *    number. A pool of 5 there is a hard cap of five concurrent queries for the
 *    whole process: request six onwards queues behind them no matter how idle
 *    the cluster is. That is the wrong reasoning carried over from Lambda, and
 *    it is what shows up as latency that climbs with concurrency while Atlas
 *    reports almost no load.
 *
 *    20 x 4 containers = 80 connections, comfortably inside M0's 500 and
 *    nowhere near M10's 1500. It also comfortably covers the target load: with
 *    lib/cache serving settings, categories and buildings from memory, a
 *    request does roughly 1-3 short queries, so 1000 signed-in staff at a
 *    realistic 1 request/second each with ~15ms of database time per request
 *    need on the order of 15-45 sockets across the fleet - concurrency in
 *    flight, not one socket per signed-in user.
 *
 * `DB_MAX_POOL_SIZE` overrides the default for either shape. It is optional: an
 * absent or unusable value falls back to the shape default rather than refusing
 * to boot, which is why it is read from `process.env` here instead of being
 * added to the validated schema in lib/env.ts. Anything set explicitly in the
 * connection string still wins over both.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../env';

const globalForPrisma = globalThis as unknown as {
  hostelPrisma?: PrismaClient;
};

/** One request at a time per execution environment; containers are the variable. */
const LAMBDA_MAX_POOL_SIZE = 5;
/** One container serves every concurrent request; the pool is the variable. */
const SERVER_MAX_POOL_SIZE = 20;

/**
 * Sockets kept open on a long-running server so a traffic ramp does not pay for
 * a TLS handshake per new connection at exactly the moment it is busiest. Left
 * at zero on Lambda, where a warm container holding idle sockets is pure waste.
 */
const SERVER_MIN_POOL_SIZE = 5;

/** How long a request waits for a free connection before failing loudly. */
const WAIT_QUEUE_TIMEOUT_MS = 10_000;

/**
 * Both markers are set by the Lambda runtime itself and by nothing else, so
 * this identifies the shape without needing a variable someone has to remember
 * to set. Anything that is not Lambda - docker, ECS, `next start`, a dev
 * machine - is treated as a long-running server.
 */
function isServerlessRuntime(): boolean {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV);
}

function resolveMaxPoolSize(): number {
  const shapeDefault = isServerlessRuntime() ? LAMBDA_MAX_POOL_SIZE : SERVER_MAX_POOL_SIZE;
  const raw = process.env.DB_MAX_POOL_SIZE?.trim();
  if (!raw) return shapeDefault;

  const parsed = Number(raw);
  // 200 x a handful of containers is already near an M10's ceiling; a value
  // above it is far likelier to be a typo than an intention.
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 200) return parsed;

  console.warn(
    `[prisma] Ignoring DB_MAX_POOL_SIZE="${raw}": expected an integer between 1 and 200. ` +
      `Using ${shapeDefault}.`,
  );
  return shapeDefault;
}

function buildDatasourceUrl(): string {
  const config = env();
  const raw = config.DATABASE_URL;

  try {
    const url = new URL(raw);
    // Tune only what has not been set explicitly, so an operator can always
    // override any of this from the connection string itself.
    if (!url.searchParams.has('retryWrites')) url.searchParams.set('retryWrites', 'true');
    if (!url.searchParams.has('w')) url.searchParams.set('w', 'majority');

    const maxPoolSize = resolveMaxPoolSize();
    if (!url.searchParams.has('maxPoolSize')) {
      url.searchParams.set('maxPoolSize', String(maxPoolSize));
    }
    if (!url.searchParams.has('minPoolSize') && !isServerlessRuntime()) {
      url.searchParams.set('minPoolSize', String(Math.min(SERVER_MIN_POOL_SIZE, maxPoolSize)));
    }
    // Without this, a request that arrives when the pool is exhausted waits
    // indefinitely for a connection and the symptom is a hung request with no
    // error anywhere. With it, saturation is a visible failure that names its
    // own cause.
    if (!url.searchParams.has('waitQueueTimeoutMS')) {
      url.searchParams.set('waitQueueTimeoutMS', String(WAIT_QUEUE_TIMEOUT_MS));
    }
    if (!url.searchParams.has('serverSelectionTimeoutMS')) {
      url.searchParams.set('serverSelectionTimeoutMS', '10000');
    }
    return url.toString();
  } catch {
    // A malformed URL surfaces with a clearer message on the first real query.
    return raw;
  }
}

function createClient(): PrismaClient {
  const config = env();
  return new PrismaClient({
    datasources: { db: { url: buildDatasourceUrl() } },
    log:
      config.NODE_ENV === 'development'
        ? [{ emit: 'stdout', level: 'warn' }, { emit: 'stdout', level: 'error' }]
        : [{ emit: 'stdout', level: 'error' }],
    errorFormat: 'minimal',
  });
}

/**
 * The client is created on first *use*, not on import.
 *
 * Two reasons this matters:
 *  - `next build` imports every route module to collect page data. An eager
 *    client would validate the environment and demand a DATABASE_URL at build
 *    time, so a build would need production configuration it has no business
 *    knowing.
 *  - On Lambda, a cold start that only serves /api/health should not pay to
 *    construct a database client it never queries.
 *
 * The Proxy forwards every property access to a client built on demand and then
 * cached on `globalThis`, so warm invocations and dev hot reloads share one
 * instance exactly as before.
 */
function getClient(): PrismaClient {
  if (!globalForPrisma.hostelPrisma) globalForPrisma.hostelPrisma = createClient();
  return globalForPrisma.hostelPrisma;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const value = Reflect.get(getClient(), property, receiver);
    // Methods must stay bound to the real client, not to the proxy.
    return typeof value === 'function' ? value.bind(getClient()) : value;
  },
  has: (_target, property) => property in getClient(),
  ownKeys: () => Reflect.ownKeys(getClient()),
  getOwnPropertyDescriptor: (_target, property) =>
    Reflect.getOwnPropertyDescriptor(getClient(), property),
});

/**
 * Anything that can run a query: the client itself, or a transaction handle.
 * Repositories accept this so they compose inside `prisma.$transaction`.
 */
export type PrismaLike = PrismaClient | Prisma.TransactionClient;

export { Prisma };
export type { PrismaClient };

/**
 * Run work in a multi-document transaction.
 *
 * These require a replica set or a sharded cluster. Every Atlas deployment is a
 * replica set, so this works there; a bare standalone `mongod` would reject it.
 * That is the one deployment shape this application does not support.
 *
 * MongoDB provides snapshot isolation only, so unlike the PostgreSQL version
 * there is no isolation level to choose.
 */
export function runInTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  return getClient().$transaction(fn, {
    maxWait: 5_000,
    // MongoDB aborts a transaction server-side at 60s regardless; stay under it.
    timeout: options?.timeoutMs ?? 15_000,
  });
}

/** Used by the health endpoint and integration-test setup. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    // MongoDB has no `SELECT 1`; `ping` is the cheapest round trip available
    // and needs no collection to exist.
    await getClient().$runCommandRaw({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
