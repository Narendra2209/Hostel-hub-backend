/**
 * A small in-process TTL cache with single-flight loading.
 *
 * Why this exists
 * ---------------
 * Every authenticated request loads the User document (authentication), then
 * the HostelSettings singleton (the fee context every financial query needs),
 * and most read paths then load the building list. Settings, buildings and
 * expense categories change perhaps once a month. At 1000 signed-in staff that
 * is thousands of identical reads per second of documents that never move.
 *
 * The single-flight behaviour matters more than the caching. A cold container
 * taking 1000 simultaneous requests would otherwise fire 1000 identical
 * `findFirst` queries at Atlas before the first one returned, which is exactly
 * the moment the connection pool is least able to absorb them. Concurrent
 * misses for the same key here await ONE loader call.
 *
 * What may and may not be cached
 * ------------------------------
 * ONLY hostel-wide configuration that is identical for every caller: the
 * settings singleton, the expense-category list, the building list. Those are
 * safe to share precisely because there is nothing user-specific in them, so no
 * key can ever serve one user another user's data.
 *
 * NEVER cache anything user-scoped or resident-scoped - a User document, an
 * AuthContext, a resident's fee status, a payment list, a dashboard filtered by
 * building. A cache keyed on anything less than the full identity of the caller
 * is a data leak between accounts, and a cache keyed on the caller's identity
 * would grow one entry per session for no benefit. If a value depends on WHO is
 * asking, it does not belong here.
 *
 * Failures are never cached
 * -------------------------
 * A loader that throws leaves the cache untouched: no entry is written, the
 * single-flight slot is released, and every concurrent caller receives the same
 * rejection. The next call retries. Caching a failure would turn a two-second
 * Atlas blip into a full TTL of hard errors, and a negative entry with no way to
 * distinguish "absent" from "failed" is how a cache poisons itself.
 *
 * State lives on `globalThis`, following lib/http/rate-limit.ts, so it survives
 * Next's dev hot reload and is reused by every warm invocation of a Lambda
 * execution environment.
 *
 * This is per-container state, not a shared cache. Two containers hold
 * independent copies, so a write invalidates only the container that served it
 * and the others catch up when their entry expires. That is the deliberate
 * trade: the TTLs are short, the cached documents are configuration, and the
 * alternative (ElastiCache/Redis) is infrastructure this deployment does not
 * have. Across containers it is the TTL, not invalidation, that bounds
 * staleness - which is why the TTLs are seconds rather than hours.
 */

/** A cached value and the instant it stops being usable. */
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

interface Namespace {
  name: string;
  /** Insertion-ordered: the oldest *write* is the first key, which is what eviction drops. */
  entries: Map<string, CacheEntry>;
  /** Loads currently running, so N concurrent misses share one loader call. */
  inflight: Map<string, Promise<unknown>>;
  hits: number;
  misses: number;
  /**
   * Bumped by every `invalidate`. A load that started before the bump read the
   * database BEFORE the write that invalidated it, so publishing its result
   * would reinstate exactly the stale value the invalidation was meant to
   * remove. Comparing the epoch on publish closes that race.
   */
  epoch: number;
}

/** The shape `DiagnosticsDto.caches` expects. */
export interface CacheStat {
  name: string;
  entries: number;
  hits: number;
  misses: number;
  /** hits / (hits + misses), 0 when nothing has been looked up yet. */
  hitRate: number;
}

/**
 * Per-namespace ceiling. Every namespace this application uses holds a handful
 * of keys, so this is a backstop rather than a working limit: an unbounded map
 * on a long-running container is a memory leak, and a cache keyed on something
 * unexpectedly high-cardinality would be one.
 */
const MAX_ENTRIES_PER_NAMESPACE = 512;

/**
 * The namespaces in use, named in one place so a typo cannot silently create a
 * second cache that nothing ever invalidates. They are registered eagerly so
 * diagnostics lists them from process start rather than only after first use.
 */
export const CACHE_NAMESPACES = {
  /** The HostelSettings singleton. Hostel-wide. */
  settings: 'settings',
  /** Expense categories: the bootstrap flag and the two list shapes. Hostel-wide. */
  categories: 'categories',
  /** The building list with its dependent counts. Hostel-wide. */
  buildings: 'buildings',
} as const;

export type CacheNamespace = (typeof CACHE_NAMESPACES)[keyof typeof CACHE_NAMESPACES];

const globalForCache = globalThis as unknown as { hostelCaches?: Map<string, Namespace> };
const namespaces: Map<string, Namespace> = globalForCache.hostelCaches ?? new Map();
globalForCache.hostelCaches = namespaces;

function namespaceOf(name: string): Namespace {
  const existing = namespaces.get(name);
  if (existing) return existing;
  const created: Namespace = {
    name,
    entries: new Map(),
    inflight: new Map(),
    hits: 0,
    misses: 0,
    epoch: 0,
  };
  namespaces.set(name, created);
  return created;
}

for (const name of Object.values(CACHE_NAMESPACES)) namespaceOf(name);

/**
 * Write an entry and keep the namespace inside its cap.
 *
 * The key is deleted before it is set so that refreshing a value moves it to
 * the back of the Map's insertion order. Without that, a hot key written once
 * and refreshed forever would stay at the front and be the first thing evicted.
 */
function store(ns: Namespace, key: string, value: unknown, ttlMs: number): void {
  const now = Date.now();
  ns.entries.delete(key);
  ns.entries.set(key, { value, expiresAt: now + ttlMs });

  if (ns.entries.size <= MAX_ENTRIES_PER_NAMESPACE) return;

  // Expired entries are free to drop, so spend those first.
  for (const [candidate, entry] of ns.entries) {
    if (ns.entries.size <= MAX_ENTRIES_PER_NAMESPACE) break;
    if (entry.expiresAt <= now) ns.entries.delete(candidate);
  }
  // Still over the cap: drop the oldest write until it fits.
  while (ns.entries.size > MAX_ENTRIES_PER_NAMESPACE) {
    const oldest = ns.entries.keys().next();
    if (oldest.done) break;
    ns.entries.delete(oldest.value);
  }
}

/**
 * Return the cached value for `key`, or run `loader` once and cache what it
 * returns for `ttlMs` milliseconds.
 *
 * Concurrent misses for the same key await the same loader call. A caller that
 * joins an in-flight load counts as a miss - it did not get an answer without
 * waiting - even though it did not cause a second query. `hitRate` therefore
 * reads as "share of lookups served immediately", which is the number worth
 * watching.
 *
 * A `ttlMs` of zero or less disables storage while keeping single-flight, which
 * is a useful way to switch one cache off without removing its call sites.
 */
export async function getOrLoad<T>(
  namespace: string,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const ns = namespaceOf(namespace);
  const now = Date.now();

  const entry = ns.entries.get(key);
  if (entry) {
    if (entry.expiresAt > now) {
      ns.hits += 1;
      return entry.value as T;
    }
    ns.entries.delete(key);
  }

  ns.misses += 1;

  const running = ns.inflight.get(key);
  if (running) return running as Promise<T>;

  const epoch = ns.epoch;
  const promise = (async () => {
    const value = await loader();
    // Do not publish a value an invalidation has already overtaken, and do not
    // publish at all when caching is disabled for this call.
    if (ttlMs > 0 && ns.epoch === epoch) store(ns, key, value, ttlMs);
    return value;
  })();

  ns.inflight.set(key, promise);

  // Release the slot however the load ends. On failure nothing was stored, so
  // the next caller retries against the database rather than inheriting the
  // error. Attaching a handler here also means the rejection is never unhandled
  // even when no caller is waiting yet.
  const release = (): void => {
    if (ns.inflight.get(key) === promise) ns.inflight.delete(key);
  };
  promise.then(release, release);

  return promise;
}

/**
 * Drop one key, or the whole namespace when `key` is omitted.
 *
 * Call this AFTER the transaction that changed the data has committed. Dropping
 * the entry while the write is still open lets a concurrent read repopulate the
 * cache with the pre-write value, which is worse than not caching at all.
 */
export function invalidate(namespace: string, key?: string): void {
  const ns = namespaces.get(namespace);
  if (!ns) return;
  if (key === undefined) ns.entries.clear();
  else ns.entries.delete(key);
  // Also disqualifies loads already in flight from publishing their results.
  // Bumping the whole namespace for a single-key invalidation occasionally
  // discards an unrelated key's in-flight result, which costs one extra query
  // and can never serve stale data. That asymmetry is deliberate.
  ns.epoch += 1;
}

/** Per-namespace counters, for the diagnostics endpoint. */
export function cacheStats(): CacheStat[] {
  const now = Date.now();
  return [...namespaces.values()]
    .map((ns) => {
      let live = 0;
      for (const entry of ns.entries.values()) {
        if (entry.expiresAt > now) live += 1;
      }
      const lookups = ns.hits + ns.misses;
      return {
        name: ns.name,
        entries: live,
        hits: ns.hits,
        misses: ns.misses,
        // Four decimal places: enough to show 0.9987, short enough to render.
        hitRate: lookups === 0 ? 0 : Math.round((ns.hits / lookups) * 10_000) / 10_000,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Forget every entry and every counter.
 * For tests, and for a diagnostics "clear caches" action if one is ever added.
 */
export function resetCaches(): void {
  for (const ns of namespaces.values()) {
    ns.entries.clear();
    ns.hits = 0;
    ns.misses = 0;
    // In-flight loads must not repopulate what was just cleared.
    ns.epoch += 1;
  }
}
