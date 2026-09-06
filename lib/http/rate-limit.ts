/**
 * A small in-process rate limiter.
 *
 * This is the *last* line of defence, not the primary one. On Lambda each
 * execution environment has its own counter, so the effective limit scales with
 * concurrency. The authoritative production limits are API Gateway throttling
 * and, optionally, AWS WAF rate-based rules - both configured in the CDK stack.
 * This exists so a single misbehaving client cannot hammer one warm container.
 *
 * Per user, not per IP
 * --------------------
 * There are two budgets here and they are not interchangeable:
 *
 *  * The PER-USER budget is the real control. A signed-in account is a real
 *    identity that cannot be forged or rotated, so limiting it is both fair and
 *    meaningful.
 *
 *  * The PER-IP budget exists only for requests where there is no user yet:
 *    login, the first-run bootstrap, the auth status probe, health. That is the
 *    brute-force surface, and it stays tight.
 *
 * Charging both for every request - which is what this file used to do - breaks
 * as soon as clients share an egress IP. A hostel office puts all of its staff
 * behind one NAT, so 1000 signed-in staff would divide one 300/minute IP budget
 * between them and get a handful of requests each per minute while their own
 * per-user budgets sat almost untouched.
 *
 * How the IP charge is released
 * -----------------------------
 * `lib/http/handler.ts` charges the IP bucket BEFORE it authenticates, so that
 * an unauthenticated flood cannot make the server do work per request, and then
 * charges the user bucket once the token has been verified. The IP charge is
 * therefore provisional: `clientKey` opens a per-request async scope recording
 * what was charged, and the per-user charge hands it back. The result is:
 *
 *  * Authenticated request           -> IP charge refunded, per-user budget applies.
 *  * Anonymous route (login etc.)    -> no user charge follows, so the IP charge
 *                                       stands, and login stays limited per
 *                                       address on top of the per-account
 *                                       lockout in auth.service.
 *  * Invalid or expired token        -> authentication throws before the user
 *                                       charge, so the IP charge stands and a
 *                                       flood of forged tokens is still limited.
 *
 * A caller cannot buy its way out of the IP budget by attaching a junk
 * credential, because it is the *verified* user - not the presence of a header -
 * that releases the charge. That is the property worth preserving; anything
 * keyed on what the client sends can be rotated at will, so "has an
 * Authorization header" would have been no control at all.
 *
 * The one limit that remains
 * --------------------------
 * A charge is provisional for as long as the request takes to authenticate, so
 * what a shared address holds against the IP budget is its number of requests
 * IN FLIGHT, not its request rate. `ipBudget()` is sized for that. The tighter
 * fix - never charging the IP bucket on a route that requires authentication -
 * lives in the two call sites in lib/http/handler.ts, which this file cannot
 * reach on its own.
 *
 * `AsyncLocalStorage.enterWith` binds the scope for the rest of the current
 * synchronous execution and everything awaited from it, which is the lifetime
 * of one request under the Next node runtime. If a runtime ever shares one
 * async context between two requests, the only consequence is that a refund
 * lands on a sibling request's charge for the same IP - a few units either way,
 * never a bypass. When no async context is available at all the refund is
 * skipped and the limiter behaves exactly as it did before.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '../env';
import { RateLimitError } from '../errors/app-error';

interface Bucket {
  count: number;
  resetAt: number;
}

/** What the IP bucket was charged for the request currently being served. */
interface ProvisionalIpCharge {
  key: string;
  /** Units charged, zeroed once refunded so a refund can never be taken twice. */
  charged: number;
  /** The window the charge landed in; a refund into a later window would be wrong. */
  resetAt: number;
}

const globalForLimiter = globalThis as unknown as {
  hostelRateBuckets?: Map<string, Bucket>;
  hostelRateRequestScope?: AsyncLocalStorage<ProvisionalIpCharge>;
};

const buckets: Map<string, Bucket> = globalForLimiter.hostelRateBuckets ?? new Map();
globalForLimiter.hostelRateBuckets = buckets;

const requestScope: AsyncLocalStorage<ProvisionalIpCharge> =
  globalForLimiter.hostelRateRequestScope ?? new AsyncLocalStorage<ProvisionalIpCharge>();
globalForLimiter.hostelRateRequestScope = requestScope;

const MAX_TRACKED_KEYS = 10_000;

/** Keys the handler builds for an authenticated caller. */
const USER_KEY_PREFIX = 'user:';
/** Keys `clientKey` builds when there is no verified user. */
const IP_KEY_PREFIX = 'ip:';

/** The per-user key `lib/http/handler.ts` charges once a token has been verified. */
export const userKey = (userId: string): string => `${USER_KEY_PREFIX}${userId}`;

/**
 * The per-IP budget, in weighted units per window.
 *
 * Sizing this is not about throughput. Because an authenticated request hands
 * its IP charge back, sustained signed-in traffic costs the IP bucket nothing:
 * what a shared address actually holds at any moment is one charge per request
 * that is IN FLIGHT and not yet verified - roughly a few milliseconds each.
 * So the number to cover is peak CONCURRENCY from one egress address, not
 * requests per minute.
 *
 *     1000 staff behind one office NAT, every one of them waiting on a request
 *     at the same instant = 1000 units held simultaneously. 2000 is that with
 *     headroom, and it is what a 1000-connection load test from a single host
 *     needs too.
 *
 * The cost is the brute-force surface: at login's weight of 5, this allows 400
 * sign-in attempts per minute per address rather than 60. That is a deliberate
 * trade, and it is affordable because the per-IP budget is NOT what stops a
 * brute-force attack - `auth.service` locks an account after
 * LOGIN_MAX_ATTEMPTS (8) failures for LOGIN_LOCKOUT_MINUTES (15), which is
 * per-account, unaffected by any of this, and bites long before the IP budget
 * does. Volumetric defence belongs to API Gateway and WAF, as the note at the
 * top of this file says.
 *
 * `RATE_LIMIT_IP_MAX_REQUESTS` overrides it: set it to 300 to restore the old
 * behaviour on a deployment whose clients do not share an address, or higher
 * for an office larger than this. It is optional and read straight from
 * `process.env` - an unusable value falls back to the default rather than
 * stopping the API from booting.
 */
const IP_BUDGET_DEFAULT = 2_000;

function ipBudget(): number {
  const raw = process.env.RATE_LIMIT_IP_MAX_REQUESTS?.trim();
  if (!raw) return IP_BUDGET_DEFAULT;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.warn(
    `[rate-limit] Ignoring RATE_LIMIT_IP_MAX_REQUESTS="${raw}": expected a positive integer. ` +
      `Using ${IP_BUDGET_DEFAULT}.`,
  );
  return IP_BUDGET_DEFAULT;
}

function sweep(now: number): void {
  if (buckets.size < MAX_TRACKED_KEYS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Still oversized after sweeping expired entries: drop the oldest wholesale
  // rather than let memory grow without bound.
  if (buckets.size >= MAX_TRACKED_KEYS) buckets.clear();
}

/** Add `weight` to `key`'s bucket and throw once it is over `budget`. */
function charge(key: string, weight: number, budget: number): Bucket {
  const { RATE_LIMIT_WINDOW_MS } = env();
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const fresh: Bucket = { count: weight, resetAt: now + RATE_LIMIT_WINDOW_MS };
    buckets.set(key, fresh);
    return fresh;
  }

  existing.count += weight;
  if (existing.count > budget) {
    throw new RateLimitError(Math.max(1, Math.ceil((existing.resetAt - now) / 1000)));
  }
  return existing;
}

/** The per-request scope, or undefined outside one. */
function currentScope(): ProvisionalIpCharge | undefined {
  try {
    return requestScope.getStore();
  } catch {
    return undefined;
  }
}

/**
 * Hand back the IP charge this request made before it was known to belong to a
 * real user. Only refunds into the window the charge landed in, so a request
 * that straddles a window boundary cannot take units out of the new one.
 */
function refundProvisionalIpCharge(): void {
  const pending = currentScope();
  if (!pending || pending.charged <= 0) return;

  const bucket = buckets.get(pending.key);
  if (bucket && bucket.resetAt === pending.resetAt) {
    bucket.count = Math.max(0, bucket.count - pending.charged);
  }
  pending.charged = 0;
}

/**
 * Throws RateLimitError when `key` exceeds the budget for its kind.
 *
 * `key` is either `user:<id>` for a verified caller - the real control - or the
 * `ip:<address>` key `clientKey` returns, which is the tight budget that guards
 * the endpoints reached before anyone has signed in.
 *
 * A user charge releases the IP charge made earlier in the same request, so a
 * shared office address is not spent by traffic that a per-user budget is
 * already accounting for. Note that a request rejected between authentication
 * and the user charge - a VIEWER calling an OWNER-only route - is never
 * refunded: repeated 403s from one address are abuse-shaped and keep costing IP
 * budget deliberately.
 */
export function enforceRateLimit(key: string, weight = 1): void {
  if (key.startsWith(USER_KEY_PREFIX)) {
    refundProvisionalIpCharge();
    charge(key, weight, env().RATE_LIMIT_MAX_REQUESTS);
    return;
  }

  const bucket = charge(key, weight, ipBudget());

  // Record it as provisional so a later user charge can release it. Anything
  // that never reaches a user charge simply keeps the charge.
  const scope = currentScope();
  if (scope && scope.key === key) {
    scope.charged += weight;
    scope.resetAt = bucket.resetAt;
  }
}

/** The address a request appears to come from, behind a proxy or not. */
function clientAddress(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return headers.get('x-real-ip') ?? 'unknown-client';
}

/**
 * Best-effort client identifier when there is no authenticated user yet, and
 * the point at which the per-request scope is opened.
 *
 * `lib/http/handler.ts` calls this once per request, before authentication, so
 * this is the only place that can establish the scope the refund needs.
 */
export function clientKey(headers: Headers): string {
  const key = `${IP_KEY_PREFIX}${clientAddress(headers)}`;
  try {
    requestScope.enterWith({ key, charged: 0, resetAt: 0 });
  } catch {
    // No async context in this runtime: the charge simply stays, which is the
    // behaviour this limiter had before refunds existed.
  }
  return key;
}

/** Test helper. */
export function resetRateLimits(): void {
  buckets.clear();
}
