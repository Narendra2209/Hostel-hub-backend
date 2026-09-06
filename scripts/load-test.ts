/**
 * LOAD TEST - a dependency-free load generator for the Hostel Manager API.
 *
 * WHAT IT DOES
 * ------------
 * Signs in as N distinct accounts, then drives a weighted mix of the six reads
 * that dominate real traffic, ramping virtual-user count through a series of
 * stages and reporting latency percentiles and error counts for each stage and
 * each endpoint. It exits non-zero when a stage breaches the p95 budget or the
 * error-rate budget, so it can be used as a release gate.
 *
 * WHY NO LIBRARY
 * --------------
 * `fetch` and `Promise.all` are all a closed-loop generator needs. Adding k6 or
 * autocannon would mean a binary or a native dependency in an environment that
 * already refuses native modules for password hashing (see lib/auth/password.ts).
 * Node's own concurrency is enough, and being in-process means the scenario mix
 * is defined against the same DTO contract the application uses.
 *
 * WHY IT SIGNS IN AS MANY USERS
 * -----------------------------
 * `requireAuth` verifies the JWT *and* re-reads the User document on every
 * single request, so authentication is a database round trip that scales with
 * traffic. A load test that reuses one token would measure one hot document and
 * would hide that cost. Each virtual user is pinned to one of N real sessions,
 * exactly as N real people would be.
 *
 * WHY IT SENDS X-Forwarded-For
 * ----------------------------
 * lib/http/rate-limit.ts keys anonymous traffic on `clientKey(headers)`, which
 * falls back to the literal string 'unknown-client' when there is no
 * X-Forwarded-For. Without the header every request in the run would share one
 * bucket and the whole test would be a measurement of the rate limiter. Each
 * virtual user therefore presents a distinct synthetic client address, which is
 * what an API Gateway deployment puts there anyway. The per-*user* bucket is
 * still shared, so the server under test must be started with a raised
 * RATE_LIMIT_MAX_REQUESTS - the run warns loudly when 429s appear.
 *
 * USAGE
 * -----
 *   npx tsx scripts/load-test.ts --url http://localhost:4100
 *   npx tsx scripts/load-test.ts --url http://localhost:4100 \
 *       --users 40 --duration 30 --stages 50,200,500,1000
 *
 * FLAGS
 *   --url          Base URL of the API.            Default http://localhost:4100
 *   --users        Distinct accounts to sign in.   Default 40
 *   --duration     Seconds to hold each stage.     Default 30
 *   --stages       Virtual users per stage (csv).  Default 50,200,500,1000
 *   --ramp         Seconds to stagger VU start-up. Default 3
 *   --warmup       Seconds of 5-VU traffic first.  Default 5
 *   --think        Milliseconds between a VU's requests. Default 0 (closed loop)
 *   --p95          p95 budget in ms; gate.         Default 1500
 *   --error-rate   Max error percentage; gate.     Default 1
 *   --json         Write the raw results to this file.
 *   --no-gate      Report only; always exit 0.
 */
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

/* ------------------------------------------------------------------ *
 * The credential convention, shared with scripts/seed-scale-data.ts.
 *
 * These constants live HERE, in the lighter module, and the seed imports them.
 * The other direction would pull Prisma and the MongoDB driver into the load
 * generator's process, and a load generator should carry nothing it does not
 * need while it is holding a thousand sockets open.
 * ------------------------------------------------------------------ */

/** A domain that cannot resolve, so a stray mail can never leave the building. */
export const LOAD_TEST_EMAIL_DOMAIN = 'scaletest.local';

/** Satisfies validatePasswordStrength(); known, because these are fixtures. */
export const LOAD_TEST_PASSWORD = 'ScaleTest@2026';

/** How many sign-in accounts the seed creates. */
export const LOAD_TEST_USER_COUNT = 40;

/** Structurally identical to @hostel/shared's UserRole, declared locally so
 *  this file keeps its zero-import property. */
export type LoadTestRole = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'MANAGER' | 'VIEWER';

export const loadTestEmail = (index: number): string =>
  `loadtest${String(index + 1).padStart(3, '0')}@${LOAD_TEST_EMAIL_DOMAIN}`;

export const loadTestName = (index: number): string =>
  `Load Test User ${String(index + 1).padStart(3, '0')}`;

/**
 * A role mix rather than forty identical viewers: the first four accounts cover
 * every privileged role so the run exercises the real `requireRole` branches,
 * and the rest are viewers, which is what a read-heavy population looks like.
 */
export function loadTestRole(index: number): LoadTestRole {
  switch (index) {
    case 0:
      return 'OWNER';
    case 1:
      return 'ADMIN';
    case 2:
      return 'DEVELOPER';
    case 3:
      return 'MANAGER';
    default:
      return 'VIEWER';
  }
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

interface Options {
  url: string;
  users: number;
  durationSeconds: number;
  stages: number[];
  rampSeconds: number;
  warmupSeconds: number;
  thinkMs: number;
  p95BudgetMs: number;
  maxErrorRatePct: number;
  jsonPath: string | null;
  gate: boolean;
}

const DEFAULTS = {
  url: 'http://localhost:4100',
  users: LOAD_TEST_USER_COUNT,
  durationSeconds: 30,
  stages: [50, 200, 500, 1000],
  rampSeconds: 3,
  warmupSeconds: 5,
  thinkMs: 0,
  p95BudgetMs: 1500,
  maxErrorRatePct: 1,
} as const;

function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const equals = arg.indexOf('=');
    if (equals >= 0) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      i += 1;
    } else {
      flags.set(arg.slice(2), 'true');
    }
  }
  return flags;
}

function numberFlag(
  flags: Map<string, string>,
  name: string,
  fallback: number,
  { allowZero = false }: { allowZero?: boolean } = {},
): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  const valid = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  if (!valid) {
    throw new Error(
      `--${name} must be a ${allowZero ? 'non-negative' : 'positive'} number (got "${raw}")`,
    );
  }
  return value;
}

export function parseOptions(argv: string[]): Options {
  const flags = readFlags(argv);

  const stagesRaw = flags.get('stages');
  const stages = stagesRaw
    ? stagesRaw
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.trunc(value))
    : [...DEFAULTS.stages];
  if (stages.length === 0) throw new Error('--stages must list at least one positive number');

  const url = (flags.get('url') ?? DEFAULTS.url).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new Error(`--url must be an http(s) URL (got "${url}")`);

  return {
    url,
    users: Math.max(1, Math.trunc(numberFlag(flags, 'users', DEFAULTS.users))),
    durationSeconds: numberFlag(flags, 'duration', DEFAULTS.durationSeconds),
    stages,
    rampSeconds: numberFlag(flags, 'ramp', DEFAULTS.rampSeconds, { allowZero: true }),
    warmupSeconds: numberFlag(flags, 'warmup', DEFAULTS.warmupSeconds, { allowZero: true }),
    thinkMs: numberFlag(flags, 'think', DEFAULTS.thinkMs, { allowZero: true }),
    p95BudgetMs: numberFlag(flags, 'p95', DEFAULTS.p95BudgetMs),
    maxErrorRatePct: numberFlag(flags, 'error-rate', DEFAULTS.maxErrorRatePct, { allowZero: true }),
    jsonPath: flags.get('json') ?? null,
    gate: flags.get('no-gate') !== 'true',
  };
}

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Deterministic PRNG, so two runs pick the same request sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(values: readonly T[], rand: () => number): T =>
  values[Math.floor(rand() * values.length) % values.length]!;

/** "2026-09" shifted by `step` months, without pulling in @hostel/shared. */
function shiftMonth(monthKey: string, step: number): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const zeroBased = year * 12 + (month - 1) + step;
  const shiftedYear = Math.floor(zeroBased / 12);
  const shiftedMonth = (zeroBased % 12) + 1;
  return `${shiftedYear}-${String(shiftedMonth).padStart(2, '0')}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]!;
}

const fmt = (value: number, digits = 0): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** The error code undici buries in `cause`, which is the useful half. */
function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? code : cause.message;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.message;
}

/* ------------------------------------------------------------------ *
 * The scenario mix
 * ------------------------------------------------------------------ */

/** Everything the request builders need to look like a real client. */
interface World {
  /** The month the API considers current, learned from /api/dashboard. */
  currentMonth: string;
  /** Recent months, so requests are not all one hot key. */
  months: string[];
  buildingIds: string[];
  residentIds: string[];
  residentPages: number;
  expensePages: number;
}

interface Scenario {
  readonly name: string;
  readonly weight: number;
  readonly build: (world: World, rand: () => number) => string;
}

/**
 * Weighted the way the SPA actually behaves: the Overview is the landing
 * screen and is re-fetched on every month or building change, the ledger and
 * the roster are the two screens a warden lives in, and everything else is
 * navigated to occasionally.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    name: 'dashboard',
    weight: 30,
    build: (world, rand) => {
      const month = pick(world.months, rand);
      // A quarter of dashboard loads are filtered to one building, which is
      // what the building switcher does.
      const building = rand() < 0.25 && world.buildingIds.length > 0 ? pick(world.buildingIds, rand) : 'all';
      return `/api/dashboard?month=${month}&buildingId=${building}&stripLimit=15`;
    },
  },
  {
    name: 'fee-ledger',
    weight: 20,
    build: (world, rand) => {
      const month = pick(world.months, rand);
      // PAYMENT_STATUSES in @hostel/shared, spelled out rather than imported so
      // this file keeps its zero-import property. `all` dominates because that
      // is the default the ledger screen opens on.
      const status = pick(['all', 'all', 'all', 'OVERDUE', 'PART_PAID'] as const, rand);
      return `/api/fees?month=${month}&buildingId=all&status=${status}&sortBy=name&sortOrder=asc`;
    },
  },
  {
    name: 'residents',
    weight: 20,
    build: (world, rand) => {
      const page = 1 + Math.floor(rand() * Math.max(1, world.residentPages));
      const month = pick(world.months, rand);
      return `/api/residents?page=${page}&pageSize=20&status=staying&month=${month}&sortBy=name&sortOrder=asc`;
    },
  },
  {
    name: 'overdue',
    weight: 10,
    build: (world, rand) => {
      const groupBy = rand() < 0.5 ? 'month' : 'resident';
      return `/api/overdue?page=1&pageSize=50&groupBy=${groupBy}&sortBy=daysOverdue&sortOrder=desc`;
    },
  },
  {
    name: 'expenses',
    weight: 10,
    build: (world, rand) => {
      const page = 1 + Math.floor(rand() * Math.max(1, world.expensePages));
      const month = pick(world.months, rand);
      return `/api/expenses?page=${page}&pageSize=50&month=${month}&sortBy=date&sortOrder=desc`;
    },
  },
  {
    name: 'resident-profile',
    weight: 10,
    build: (world, rand) => {
      const id = pick(world.residentIds, rand);
      return `/api/residents/${id}/profile`;
    },
  },
];

const TOTAL_WEIGHT = SCENARIOS.reduce((sum, scenario) => sum + scenario.weight, 0);

function pickScenario(rand: () => number): Scenario {
  let ticket = rand() * TOTAL_WEIGHT;
  for (const scenario of SCENARIOS) {
    ticket -= scenario.weight;
    if (ticket <= 0) return scenario;
  }
  return SCENARIOS[SCENARIOS.length - 1]!;
}

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

interface Bucket {
  latencies: number[];
  /** HTTP status -> count. */
  statuses: Map<number, number>;
  /** Transport failure code (ECONNRESET, UND_ERR_*) -> count. */
  networkErrors: Map<string, number>;
  bytes: number;
}

const newBucket = (): Bucket => ({
  latencies: [],
  statuses: new Map(),
  networkErrors: new Map(),
  bytes: 0,
});

function bucketFor(buckets: Map<string, Bucket>, name: string): Bucket {
  const existing = buckets.get(name);
  if (existing) return existing;
  const fresh = newBucket();
  buckets.set(name, fresh);
  return fresh;
}

function bump<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

interface Summary {
  requests: number;
  errors: number;
  errorRatePct: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  statuses: Map<number, number>;
  networkErrors: Map<string, number>;
  bytes: number;
}

function summarise(buckets: Iterable<Bucket>, elapsedMs: number): Summary {
  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  const networkErrors = new Map<string, number>();
  let bytes = 0;

  for (const bucket of buckets) {
    for (const value of bucket.latencies) latencies.push(value);
    for (const [status, count] of bucket.statuses) {
      statuses.set(status, (statuses.get(status) ?? 0) + count);
    }
    for (const [code, count] of bucket.networkErrors) {
      networkErrors.set(code, (networkErrors.get(code) ?? 0) + count);
    }
    bytes += bucket.bytes;
  }

  latencies.sort((a, b) => a - b);
  const requests = latencies.length;
  let errors = 0;
  for (const [status, count] of statuses) {
    if (status >= 400) errors += count;
  }
  for (const count of networkErrors.values()) errors += count;

  const sum = latencies.reduce((total, value) => total + value, 0);
  const seconds = elapsedMs / 1000;

  return {
    requests,
    errors,
    errorRatePct: requests === 0 ? 0 : (errors / requests) * 100,
    throughput: seconds > 0 ? requests / seconds : 0,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.length > 0 ? latencies[latencies.length - 1]! : 0,
    mean: requests === 0 ? 0 : sum / requests,
    statuses,
    networkErrors,
    bytes,
  };
}

interface StageResult {
  label: string;
  vus: number;
  elapsedMs: number;
  buckets: Map<string, Bucket>;
  summary: Summary;
}

/* ------------------------------------------------------------------ *
 * Sign-in
 * ------------------------------------------------------------------ */

interface Session {
  email: string;
  role: string;
  token: string;
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  meta?: unknown;
  error?: { code: string; message: string };
}

/** A stable synthetic client address per virtual user; see the header note. */
const clientAddress = (index: number): string =>
  `10.${(index >> 16) & 0xff}.${(index >> 8) & 0xff}.${index & 0xff}`;

async function signIn(baseUrl: string, index: number): Promise<{ session: Session; ms: number }> {
  const email = loadTestEmail(index);
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-forwarded-for': clientAddress(index),
    },
    body: JSON.stringify({ email, password: LOAD_TEST_PASSWORD }),
  });
  const body = (await response.json()) as Envelope<{ token: string; user: { role: string } }>;
  const ms = performance.now() - started;

  if (!response.ok || !body.success || !body.data?.token) {
    const reason = body.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Sign-in failed for ${email}: ${reason}`);
  }
  return { session: { email, role: body.data.user.role, token: body.data.token }, ms };
}

/**
 * Sign in sequentially in small groups.
 *
 * scrypt at N=2^15 costs ~32 MB and ~100 ms per verification and runs on the
 * libuv thread pool (four threads by default), so firing forty logins at once
 * would only queue them and would make the reported login latency meaningless.
 */
async function signInAll(baseUrl: string, count: number): Promise<{ sessions: Session[]; timings: number[] }> {
  const sessions: Session[] = [];
  const timings: number[] = [];
  const groupSize = 4;

  for (let start = 0; start < count; start += groupSize) {
    const group = Array.from(
      { length: Math.min(groupSize, count - start) },
      (_, offset) => start + offset,
    );
    const results = await Promise.all(group.map((index) => signIn(baseUrl, index)));
    for (const result of results) {
      sessions.push(result.session);
      timings.push(result.ms);
    }
    process.stdout.write(`\r  signed in ${sessions.length}/${count}   `);
  }
  process.stdout.write('\n');
  return { sessions, timings };
}

/* ------------------------------------------------------------------ *
 * Discovery: learn the dataset instead of assuming it
 * ------------------------------------------------------------------ */

async function getJson<T>(baseUrl: string, path: string, token: string): Promise<Envelope<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'x-forwarded-for': '10.255.255.254',
    },
  });
  const body = (await response.json()) as Envelope<T>;
  if (!response.ok || !body.success) {
    throw new Error(`GET ${path} -> ${response.status} ${body.error?.message ?? ''}`.trim());
  }
  return body;
}

async function discoverWorld(baseUrl: string, token: string): Promise<World> {
  const dashboard = await getJson<{ month: string }>(baseUrl, '/api/dashboard?stripLimit=5', token);
  const currentMonth = dashboard.data?.month ?? new Date().toISOString().slice(0, 7);

  const buildings = await getJson<{ id: string }[]>(baseUrl, '/api/buildings', token);
  const residents = await getJson<{ id: string }[]>(
    baseUrl,
    '/api/residents?page=1&pageSize=200&status=staying&includeFees=false',
    token,
  );
  const expenses = await getJson<{ id: string }[]>(baseUrl, '/api/expenses?page=1&pageSize=1', token);

  const residentMeta = residents.meta as { total?: number; pageSize?: number } | undefined;
  const expenseMeta = expenses.meta as { total?: number } | undefined;

  const residentIds = (residents.data ?? []).map((row) => row.id);
  if (residentIds.length === 0) {
    throw new Error(
      'The API returned no residents. Point --url at an instance backed by the scale database ' +
        '(npm run seed:scale) before load testing.',
    );
  }

  return {
    currentMonth,
    // Six months of history: enough that the month key is not one hot value,
    // few enough that every request still touches real data.
    months: Array.from({ length: 6 }, (_, index) => shiftMonth(currentMonth, -index)),
    buildingIds: (buildings.data ?? []).map((row) => row.id),
    residentIds,
    residentPages: Math.max(1, Math.ceil((residentMeta?.total ?? residentIds.length) / 20)),
    expensePages: Math.max(1, Math.ceil((expenseMeta?.total ?? 50) / 50)),
  };
}

/* ------------------------------------------------------------------ *
 * The generator
 * ------------------------------------------------------------------ */

interface VirtualUserArgs {
  index: number;
  vus: number;
  options: Options;
  world: World;
  session: Session;
  buckets: Map<string, Bucket>;
  deadline: number;
  rampMs: number;
}

async function runVirtualUser(args: VirtualUserArgs): Promise<void> {
  const { index, vus, options, world, session, buckets, deadline, rampMs } = args;

  // Stagger start-up: a thousand sockets opening in the same millisecond
  // measures the TCP accept queue, not the application.
  if (rampMs > 0 && vus > 1) await sleep((index / vus) * rampMs);

  const rand = mulberry32((index + 1) * 0x9e3779b1);
  const headers = {
    authorization: `Bearer ${session.token}`,
    accept: 'application/json',
    'x-forwarded-for': clientAddress(index),
  };

  while (performance.now() < deadline) {
    const scenario = pickScenario(rand);
    const bucket = bucketFor(buckets, scenario.name);
    const url = `${options.url}${scenario.build(world, rand)}`;
    const started = performance.now();

    try {
      const response = await fetch(url, { headers });
      // The body MUST be drained or undici never returns the socket to the
      // pool, and the run degenerates into connection starvation.
      const body = await response.arrayBuffer();
      bucket.latencies.push(performance.now() - started);
      bump(bucket.statuses, response.status);
      bucket.bytes += body.byteLength;
    } catch (error) {
      bucket.latencies.push(performance.now() - started);
      bump(bucket.networkErrors, errorLabel(error));
    }

    if (options.thinkMs > 0) await sleep(options.thinkMs);
  }
}

async function runStage(
  label: string,
  vus: number,
  durationMs: number,
  options: Options,
  world: World,
  sessions: Session[],
): Promise<StageResult> {
  const buckets = new Map<string, Bucket>();
  const rampMs = Math.min(options.rampSeconds * 1000, durationMs / 3);
  const startedAt = performance.now();
  const deadline = startedAt + rampMs + durationMs;

  await Promise.all(
    Array.from({ length: vus }, (_, index) =>
      runVirtualUser({
        index,
        vus,
        options,
        world,
        // Pin each virtual user to one session, the way one person keeps one
        // login. With more VUs than accounts the sessions are shared evenly.
        session: sessions[index % sessions.length]!,
        buckets,
        deadline,
        rampMs,
      }),
    ),
  );

  const elapsedMs = performance.now() - startedAt;
  return { label, vus, elapsedMs, buckets, summary: summarise(buckets.values(), elapsedMs) };
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)))
      .join('  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  return [line(headers), divider, ...rows.map(line)].join('\n');
}

const statusLine = (summary: Summary): string => {
  const parts = [...summary.statuses.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([status, count]) => `${status}:${fmt(count)}`);
  for (const [code, count] of [...summary.networkErrors.entries()].sort()) {
    parts.push(`${code}:${fmt(count)}`);
  }
  return parts.join('  ') || '-';
};

function summaryRow(label: string, summary: Summary): string[] {
  return [
    label,
    fmt(summary.requests),
    fmt(summary.throughput, 1),
    fmt(summary.p50, 1),
    fmt(summary.p95, 1),
    fmt(summary.p99, 1),
    fmt(summary.max, 1),
    fmt(summary.errors),
    `${fmt(summary.errorRatePct, 2)}%`,
  ];
}

const SUMMARY_HEADERS = ['', 'requests', 'req/s', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'errors', 'err %'];

function reportStage(stage: StageResult): void {
  console.info('');
  console.info(
    `STAGE ${stage.label}  -  ${stage.vus} virtual users, ${fmt(stage.elapsedMs / 1000, 1)}s wall clock`,
  );

  const rows: string[][] = [];
  for (const scenario of SCENARIOS) {
    const bucket = stage.buckets.get(scenario.name);
    if (!bucket) continue;
    rows.push(summaryRow(scenario.name, summarise([bucket], stage.elapsedMs)));
  }
  rows.push(summaryRow('ALL', stage.summary));

  console.info(renderTable(SUMMARY_HEADERS, rows));
  console.info(`  statuses: ${statusLine(stage.summary)}`);

  const rateLimited = stage.summary.statuses.get(429) ?? 0;
  if (rateLimited > stage.summary.requests * 0.02) {
    console.info('');
    console.info(
      `  WARNING: ${fmt(rateLimited)} responses were 429. The in-process rate limiter is shaping this`,
    );
    console.info(
      '           stage, so the latency figures describe the limiter, not the application. Restart',
    );
    console.info('           the server with a raised RATE_LIMIT_MAX_REQUESTS and run again.');
  }
}

interface GateFailure {
  stage: string;
  reason: string;
}

function evaluateGate(stages: StageResult[], options: Options): GateFailure[] {
  const failures: GateFailure[] = [];
  for (const stage of stages) {
    if (stage.summary.requests === 0) {
      failures.push({ stage: stage.label, reason: 'no requests completed' });
      continue;
    }
    if (stage.summary.p95 > options.p95BudgetMs) {
      failures.push({
        stage: stage.label,
        reason: `p95 ${fmt(stage.summary.p95, 1)}ms exceeds the ${fmt(options.p95BudgetMs)}ms budget`,
      });
    }
    if (stage.summary.errorRatePct > options.maxErrorRatePct) {
      failures.push({
        stage: stage.label,
        reason: `error rate ${fmt(stage.summary.errorRatePct, 2)}% exceeds the ${fmt(
          options.maxErrorRatePct,
          2,
        )}% budget`,
      });
    }
  }
  return failures;
}

/** Maps are not JSON; flatten them for the --json artefact. */
function serialisableSummary(summary: Summary): Record<string, unknown> {
  return {
    requests: summary.requests,
    errors: summary.errors,
    errorRatePct: Number(summary.errorRatePct.toFixed(4)),
    throughputPerSecond: Number(summary.throughput.toFixed(2)),
    latencyMs: {
      p50: Number(summary.p50.toFixed(2)),
      p95: Number(summary.p95.toFixed(2)),
      p99: Number(summary.p99.toFixed(2)),
      max: Number(summary.max.toFixed(2)),
      mean: Number(summary.mean.toFixed(2)),
    },
    statuses: Object.fromEntries([...summary.statuses].map(([key, value]) => [String(key), value])),
    networkErrors: Object.fromEntries(summary.networkErrors),
    bytes: summary.bytes,
  };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function runLoadTest(options: Options): Promise<number> {
  console.info('');
  console.info('HOSTEL MANAGER - LOAD TEST');
  console.info('==========================');
  console.info(`  target        ${options.url}`);
  console.info(`  accounts      ${options.users} (${loadTestEmail(0)} ...)`);
  console.info(`  stages        ${options.stages.join(' -> ')} virtual users`);
  console.info(`  hold          ${options.durationSeconds}s per stage (+${options.rampSeconds}s ramp)`);
  console.info(`  think time    ${options.thinkMs}ms  ${options.thinkMs === 0 ? '(closed loop)' : ''}`);
  console.info(`  gate          p95 <= ${options.p95BudgetMs}ms, errors <= ${options.maxErrorRatePct}%`);
  console.info(`  generator     node ${process.version} on ${os.cpus().length} cores`);
  console.info('');

  const health = await fetch(`${options.url}/api/health`).catch(() => null);
  if (!health) throw new Error(`Nothing is listening on ${options.url}. Start the API first.`);
  console.info(`  /api/health -> ${health.status}`);
  await health.arrayBuffer();

  console.info('');
  console.info('Signing in...');
  const { sessions, timings } = await signInAll(options.url, options.users);
  const sortedLogins = [...timings].sort((a, b) => a - b);
  console.info(
    `  ${sessions.length} sessions  |  login p50 ${fmt(percentile(sortedLogins, 50), 0)}ms ` +
      `p95 ${fmt(percentile(sortedLogins, 95), 0)}ms  (scrypt verification dominates this)`,
  );
  const roleCounts = new Map<string, number>();
  for (const session of sessions) bump(roleCounts, session.role);
  console.info(`  roles: ${[...roleCounts].map(([role, count]) => `${role}x${count}`).join(' ')}`);

  console.info('');
  console.info('Discovering the dataset...');
  const world = await discoverWorld(options.url, sessions[0]!.token);
  console.info(
    `  month ${world.currentMonth}  |  ${world.buildingIds.length} buildings  |  ` +
      `${world.residentIds.length} resident ids sampled  |  ${world.residentPages} roster pages  |  ` +
      `${world.expensePages} expense pages`,
  );

  if (options.warmupSeconds > 0) {
    console.info('');
    console.info(`Warming up for ${options.warmupSeconds}s (JIT, Prisma pool, Next.js route compilation)...`);
    await runStage('warmup', 5, options.warmupSeconds * 1000, { ...options, rampSeconds: 0 }, world, sessions);
  }

  const stages: StageResult[] = [];
  for (const vus of options.stages) {
    console.info('');
    console.info(`Running ${vus} virtual users for ${options.durationSeconds}s...`);
    const stage = await runStage(
      `${vus} VU`,
      vus,
      options.durationSeconds * 1000,
      options,
      world,
      sessions,
    );
    stages.push(stage);
    reportStage(stage);
    // Let sockets drain and the event loop settle before the next step up.
    await sleep(2000);
  }

  console.info('');
  console.info('RUN SUMMARY');
  console.info('===========');
  console.info(
    renderTable(
      SUMMARY_HEADERS,
      stages.map((stage) => summaryRow(stage.label, stage.summary)),
    ),
  );

  const totalRequests = stages.reduce((sum, stage) => sum + stage.summary.requests, 0);
  const totalErrors = stages.reduce((sum, stage) => sum + stage.summary.errors, 0);
  console.info('');
  console.info(
    `  ${fmt(totalRequests)} requests, ${fmt(totalErrors)} errors ` +
      `(${fmt(totalRequests === 0 ? 0 : (totalErrors / totalRequests) * 100, 2)}%)`,
  );

  if (options.jsonPath) {
    writeFileSync(
      options.jsonPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          options: { ...options },
          world: { currentMonth: world.currentMonth, residentPages: world.residentPages },
          stages: stages.map((stage) => ({
            label: stage.label,
            virtualUsers: stage.vus,
            elapsedMs: Number(stage.elapsedMs.toFixed(0)),
            overall: serialisableSummary(stage.summary),
            byEndpoint: Object.fromEntries(
              [...stage.buckets].map(([name, bucket]) => [
                name,
                serialisableSummary(summarise([bucket], stage.elapsedMs)),
              ]),
            ),
          })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.info(`  raw results written to ${options.jsonPath}`);
  }

  const failures = evaluateGate(stages, options);
  console.info('');
  if (failures.length === 0) {
    console.info(`GATE PASSED - every stage held p95 <= ${options.p95BudgetMs}ms and errors <= ${options.maxErrorRatePct}%.`);
    return 0;
  }

  console.info('GATE FAILED');
  for (const failure of failures) console.info(`  ${failure.stage}: ${failure.reason}`);
  if (!options.gate) {
    console.info('  --no-gate given, exiting 0 anyway.');
    return 0;
  }
  return 1;
}

/** Only run when executed directly, so the seed script can import the constants. */
const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  return typeof entry === 'string' && /load-test\.(ts|js|mjs)$/.test(entry.replace(/\\/g, '/'));
};

/** Argument parsing throws synchronously, so it has to be inside the promise. */
async function main(): Promise<number> {
  return runLoadTest(parseOptions(process.argv.slice(2)));
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error('');
      console.error(error instanceof Error ? error.message : String(error));
      console.error('');
      process.exitCode = 1;
    });
}
