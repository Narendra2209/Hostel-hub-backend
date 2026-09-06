/**
 * Per-route request timings, kept in the process that served them.
 *
 * This is a *diagnostic*, not a metrics pipeline. It answers the question a
 * developer actually asks when a screen feels slow - "which endpoint is it, and
 * is it slow every time or only sometimes?" - without adding a dependency, a
 * network hop, or a write to the database on the hot path.
 *
 * Three properties make it safe to leave switched on:
 *
 *  * BOUNDED MEMORY. Each route keeps a ring buffer of its most recent
 *    `RESERVOIR_SIZE` durations and nothing else, and only `MAX_TRACKED_ROUTES`
 *    routes are tracked at once. The worst case is a few hundred kilobytes, and
 *    it cannot grow past that no matter how long the container lives.
 *  * BOUNDED CARDINALITY. Route keys are normalised before they are stored, so
 *    `/api/residents/<81 different ids>` collapses to one row rather than
 *    eighty-one. Without this an id in the path would be an unbounded key
 *    space, which is the usual way an in-memory recorder becomes a leak.
 *  * SURVIVES REUSE. State lives on `globalThis`, exactly as the rate limiter's
 *    buckets do, so a Next.js hot reload in development and a warm Lambda
 *    invocation in production both keep the history they have already gathered.
 *
 * The numbers are per *container*. On Lambda every execution environment has
 * its own reservoir, so this describes the container answering the diagnostics
 * request and not the fleet - which is exactly what `DiagnosticsDto.timings`
 * documents ("slowest routes observed by this container since it started").
 */

/** One route's timing profile, as reported by `timingSummary()`. */
export interface RouteTimingSummary {
  route: string;
  /** Every observation, which keeps counting past the reservoir's capacity. */
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface RouteReservoir {
  /** Ring buffer of the most recent durations, in milliseconds. */
  samples: number[];
  /** Next slot to overwrite once the buffer is full. */
  cursor: number;
  /** Total observations, including those the ring buffer has since evicted. */
  count: number;
  /**
   * All-time worst for this route. Kept separately because the ring buffer
   * eventually evicts the sample it came from, and a peak that scrolls out of
   * view is the one number a developer most wants to still be able to see.
   */
  max: number;
  /** When this route was last seen; drives eviction when the map is full. */
  lastAt: number;
}

const RESERVOIR_SIZE = 200;
const MAX_TRACKED_ROUTES = 200;
/** Long enough for any real path, short enough that a junk key cannot bloat. */
const MAX_ROUTE_KEY_LENGTH = 120;

const globalForMetrics = globalThis as unknown as {
  hostelRouteTimings?: Map<string, RouteReservoir>;
};
const routes: Map<string, RouteReservoir> = globalForMetrics.hostelRouteTimings ?? new Map();
globalForMetrics.hostelRouteTimings = routes;

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Collapse the variable parts of a path so one endpoint is one row.
 *
 * MongoDB ids are 24-character hex, and a few paths carry numeric or month
 * segments; all of them become `:id` so `/api/residents/68f0.../payments` is
 * counted once rather than once per resident.
 */
export function normaliseRoute(route: string): string {
  const withoutQuery = route.split('?')[0] ?? route;
  const trimmed = withoutQuery.trim();
  if (!trimmed) return 'unknown';

  // Accept either "/api/x" or "GET /api/x"; only the path part is rewritten.
  const spaceIndex = trimmed.indexOf(' ');
  const prefix = spaceIndex > 0 ? `${trimmed.slice(0, spaceIndex)} ` : '';
  const path = spaceIndex > 0 ? trimmed.slice(spaceIndex + 1) : trimmed;

  const normalisedPath = path
    .split('/')
    .map((segment) => (OBJECT_ID.test(segment) || /^\d+$/.test(segment) ? ':id' : segment))
    .join('/');

  return `${prefix}${normalisedPath}`.slice(0, MAX_ROUTE_KEY_LENGTH);
}

/**
 * Drop the route that has gone longest without a request, so a burst of new
 * keys cannot push the map past its ceiling.
 */
function evictColdestRoute(): void {
  let coldestKey: string | null = null;
  let coldestAt = Number.POSITIVE_INFINITY;
  for (const [key, entry] of routes) {
    if (entry.lastAt < coldestAt) {
      coldestAt = entry.lastAt;
      coldestKey = key;
    }
  }
  if (coldestKey !== null) routes.delete(coldestKey);
}

/**
 * Record how long one request took.
 *
 * Never throws: a diagnostic must not be able to fail a request it is only
 * observing, so a nonsensical duration is dropped rather than stored.
 */
export function recordTiming(route: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;

  const key = normaliseRoute(route);
  const duration = Math.round(ms);
  const now = Date.now();

  let entry = routes.get(key);
  if (!entry) {
    if (routes.size >= MAX_TRACKED_ROUTES) evictColdestRoute();
    entry = { samples: [], cursor: 0, count: 0, max: 0, lastAt: now };
    routes.set(key, entry);
  }

  if (entry.samples.length < RESERVOIR_SIZE) {
    entry.samples.push(duration);
  } else {
    entry.samples[entry.cursor] = duration;
    entry.cursor = (entry.cursor + 1) % RESERVOIR_SIZE;
  }

  entry.count += 1;
  if (duration > entry.max) entry.max = duration;
  entry.lastAt = now;
}

/** Nearest-rank percentile over an ascending array. `sorted` is never empty. */
function percentile(sorted: number[], fraction: number): number {
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

/**
 * Every tracked route, slowest first.
 *
 * Ordered by p95 rather than by the maximum, because one cold-start outlier
 * says less about a route than the shape of its typical worst case.
 */
export function timingSummary(): RouteTimingSummary[] {
  const summaries: RouteTimingSummary[] = [];

  for (const [route, entry] of routes) {
    if (entry.samples.length === 0) continue;
    const sorted = [...entry.samples].sort((a, b) => a - b);
    summaries.push({
      route,
      count: entry.count,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: entry.max,
    });
  }

  return summaries.sort(
    (a, b) => b.p95Ms - a.p95Ms || b.maxMs - a.maxMs || a.route.localeCompare(b.route),
  );
}

/** Test helper, mirroring `resetRateLimits()`. */
export function resetTimings(): void {
  routes.clear();
}
