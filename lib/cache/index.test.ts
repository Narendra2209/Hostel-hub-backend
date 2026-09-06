/**
 * Unit tests for the TTL cache.
 *
 * The behaviours worth protecting are the ones a caller cannot see from the
 * outside: that N concurrent misses cause exactly ONE loader call, that an
 * invalidation beats a load already in flight, and that a thrown loader leaves
 * nothing behind. Everything else here is accounting.
 *
 * No fake timers: TTLs are asserted with real millisecond waits so the test
 * exercises the same `Date.now()` comparison production does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CACHE_NAMESPACES, cacheStats, getOrLoad, invalidate, resetCaches } from './index';

const NS = 'test-namespace';

/** Resolve after `ms`, used to step over a TTL boundary. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A loader that never resolves until `release()` is called. */
function deferredLoader<T>(value: T): {
  loader: () => Promise<T>;
  release: () => void;
  calls: () => number;
} {
  let resolveIt: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resolveIt = resolve;
  });
  const loader = vi.fn(async () => {
    await gate;
    return value;
  });
  return {
    loader,
    release: () => resolveIt?.(),
    calls: () => loader.mock.calls.length,
  };
}

const statFor = (name: string) => cacheStats().find((stat) => stat.name === name);

afterEach(() => {
  resetCaches();
});

describe('getOrLoad', () => {
  it('runs the loader on a miss and returns its value', async () => {
    const loader = vi.fn(async () => 'loaded');
    await expect(getOrLoad(NS, 'k', 1_000, loader)).resolves.toBe('loaded');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serves the second call from the cache without touching the loader', async () => {
    const loader = vi.fn(async () => 'loaded');

    await getOrLoad(NS, 'k', 1_000, loader);
    await expect(getOrLoad(NS, 'k', 1_000, loader)).resolves.toBe('loaded');

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps different keys in the same namespace apart', async () => {
    await getOrLoad(NS, 'a', 1_000, async () => 'A');
    await getOrLoad(NS, 'b', 1_000, async () => 'B');

    await expect(getOrLoad(NS, 'a', 1_000, async () => 'wrong')).resolves.toBe('A');
    await expect(getOrLoad(NS, 'b', 1_000, async () => 'wrong')).resolves.toBe('B');
  });

  it('keeps the same key in different namespaces apart', async () => {
    await getOrLoad('ns-one', 'k', 1_000, async () => 'one');
    await getOrLoad('ns-two', 'k', 1_000, async () => 'two');

    await expect(getOrLoad('ns-one', 'k', 1_000, async () => 'wrong')).resolves.toBe('one');
    await expect(getOrLoad('ns-two', 'k', 1_000, async () => 'wrong')).resolves.toBe('two');
  });

  it('does not store anything when the TTL is zero, but still single-flights', async () => {
    const { loader, release, calls } = deferredLoader('value');

    const both = Promise.all([getOrLoad(NS, 'k', 0, loader), getOrLoad(NS, 'k', 0, loader)]);
    release();
    await expect(both).resolves.toEqual(['value', 'value']);
    expect(calls()).toBe(1);

    // Nothing was cached, so the next call loads again.
    const second = vi.fn(async () => 'fresh');
    await expect(getOrLoad(NS, 'k', 0, second)).resolves.toBe('fresh');
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('hit and miss accounting', () => {
  it('counts the first lookup as a miss and later lookups as hits', async () => {
    const loader = async (): Promise<string> => 'v';

    await getOrLoad(NS, 'k', 1_000, loader);
    await getOrLoad(NS, 'k', 1_000, loader);
    await getOrLoad(NS, 'k', 1_000, loader);

    const stat = statFor(NS);
    expect(stat).toBeDefined();
    expect(stat?.misses).toBe(1);
    expect(stat?.hits).toBe(2);
    expect(stat?.hitRate).toBeCloseTo(2 / 3, 4);
    expect(stat?.entries).toBe(1);
  });

  it('reports a hitRate of 0 for a namespace nothing has looked at', () => {
    const stat = statFor(CACHE_NAMESPACES.settings);
    expect(stat).toEqual({
      name: CACHE_NAMESPACES.settings,
      entries: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
    });
  });

  it('reports the namespaces the application declares, sorted by name', () => {
    const names = cacheStats().map((stat) => stat.name);
    expect(names).toEqual([...names].sort());
    for (const declared of Object.values(CACHE_NAMESPACES)) {
      expect(names).toContain(declared);
    }
  });

  it('counts a caller that joins an in-flight load as a miss', async () => {
    const { loader, release, calls } = deferredLoader('value');

    const both = Promise.all([getOrLoad(NS, 'k', 1_000, loader), getOrLoad(NS, 'k', 1_000, loader)]);
    release();
    await both;

    expect(calls()).toBe(1);
    expect(statFor(NS)?.misses).toBe(2);
    expect(statFor(NS)?.hits).toBe(0);
  });
});

describe('TTL expiry', () => {
  it('reloads once the entry has expired', async () => {
    const loader = vi.fn(async () => 'v');

    await getOrLoad(NS, 'k', 20, loader);
    await getOrLoad(NS, 'k', 20, loader);
    expect(loader).toHaveBeenCalledTimes(1);

    await sleep(35);

    await getOrLoad(NS, 'k', 20, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('serves the value the reload produced, not the expired one', async () => {
    let current = 'first';
    const loader = async (): Promise<string> => current;

    await expect(getOrLoad(NS, 'k', 20, loader)).resolves.toBe('first');
    current = 'second';
    await expect(getOrLoad(NS, 'k', 20, loader)).resolves.toBe('first');

    await sleep(35);
    await expect(getOrLoad(NS, 'k', 20, loader)).resolves.toBe('second');
  });

  it('stops counting an expired entry in `entries`', async () => {
    await getOrLoad(NS, 'k', 20, async () => 'v');
    expect(statFor(NS)?.entries).toBe(1);

    await sleep(35);
    expect(statFor(NS)?.entries).toBe(0);
  });
});

describe('single flight', () => {
  it('runs the loader ONCE for 1000 simultaneous callers', async () => {
    const { loader, release, calls } = deferredLoader('shared');

    // The cold-start case: 1000 requests arrive before the first load returns.
    const callers = Array.from({ length: 1000 }, () => getOrLoad(NS, 'k', 1_000, loader));
    release();
    const results = await Promise.all(callers);

    expect(calls()).toBe(1);
    expect(results).toHaveLength(1000);
    expect(new Set(results)).toEqual(new Set(['shared']));
    expect(statFor(NS)?.misses).toBe(1000);
  });

  it('single-flights per key, not per namespace', async () => {
    const a = deferredLoader('A');
    const b = deferredLoader('B');

    const pending = Promise.all([
      getOrLoad(NS, 'a', 1_000, a.loader),
      getOrLoad(NS, 'a', 1_000, a.loader),
      getOrLoad(NS, 'b', 1_000, b.loader),
      getOrLoad(NS, 'b', 1_000, b.loader),
    ]);
    a.release();
    b.release();

    await expect(pending).resolves.toEqual(['A', 'A', 'B', 'B']);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it('releases the slot after a load so the next miss can load again', async () => {
    const first = deferredLoader('one');
    const p = getOrLoad(NS, 'k', 5, first.loader);
    first.release();
    await p;

    await sleep(20);

    const second = vi.fn(async () => 'two');
    await expect(getOrLoad(NS, 'k', 1_000, second)).resolves.toBe('two');
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('invalidate', () => {
  it('drops one key and leaves the rest of the namespace alone', async () => {
    await getOrLoad(NS, 'a', 1_000, async () => 'A');
    await getOrLoad(NS, 'b', 1_000, async () => 'B');

    invalidate(NS, 'a');

    await expect(getOrLoad(NS, 'a', 1_000, async () => 'A2')).resolves.toBe('A2');
    await expect(getOrLoad(NS, 'b', 1_000, async () => 'wrong')).resolves.toBe('B');
  });

  it('drops the whole namespace when no key is given', async () => {
    await getOrLoad(NS, 'a', 1_000, async () => 'A');
    await getOrLoad(NS, 'b', 1_000, async () => 'B');

    invalidate(NS);

    await expect(getOrLoad(NS, 'a', 1_000, async () => 'A2')).resolves.toBe('A2');
    await expect(getOrLoad(NS, 'b', 1_000, async () => 'B2')).resolves.toBe('B2');
  });

  it('leaves other namespaces untouched', async () => {
    await getOrLoad('ns-one', 'k', 1_000, async () => 'one');
    await getOrLoad('ns-two', 'k', 1_000, async () => 'two');

    invalidate('ns-one');

    await expect(getOrLoad('ns-two', 'k', 1_000, async () => 'wrong')).resolves.toBe('two');
  });

  it('ignores a namespace that has never been used', () => {
    expect(() => invalidate('never-seen')).not.toThrow();
  });

  /**
   * The failure this prevents: an owner changes the due day while a read of the
   * old value is already in flight. Without the epoch check the in-flight load
   * would land AFTER the invalidation and reinstate the stale settings for a
   * full TTL - the owner would change the due day and not see it take effect.
   */
  it('stops a load that was already in flight from publishing a stale value', async () => {
    const { loader, release } = deferredLoader('stale');

    const inFlight = getOrLoad(NS, 'k', 1_000, loader);
    // The write commits and invalidates while the read is still outstanding.
    invalidate(NS, 'k');
    release();
    // The caller that asked still gets what its own query returned.
    await expect(inFlight).resolves.toBe('stale');

    // ...but nothing stale was published, so the next reader sees the new value.
    await expect(getOrLoad(NS, 'k', 1_000, async () => 'fresh')).resolves.toBe('fresh');
  });
});

describe('failures are not cached', () => {
  it('propagates the error and stores nothing', async () => {
    const failing = vi.fn(async () => {
      throw new Error('database unreachable');
    });

    await expect(getOrLoad(NS, 'k', 1_000, failing)).rejects.toThrow('database unreachable');
    expect(statFor(NS)?.entries).toBe(0);

    // The next call retries rather than inheriting the failure.
    const recovered = vi.fn(async () => 'recovered');
    await expect(getOrLoad(NS, 'k', 1_000, recovered)).resolves.toBe('recovered');
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('rejects every concurrent caller of one failed load, and runs it once', async () => {
    let rejectIt: ((error: Error) => void) | undefined;
    const gate = new Promise<never>((_resolve, reject) => {
      rejectIt = reject;
    });
    const failing = vi.fn(() => gate);

    const callers = Array.from({ length: 25 }, () =>
      getOrLoad(NS, 'k', 1_000, failing).then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
    );
    rejectIt?.(new Error('boom'));

    await expect(Promise.all(callers)).resolves.toEqual(Array.from({ length: 25 }, () => 'boom'));
    expect(failing).toHaveBeenCalledTimes(1);
    expect(statFor(NS)?.entries).toBe(0);
  });

  it('does not leave a poisoned single-flight slot behind', async () => {
    const failing = async (): Promise<string> => {
      throw new Error('first attempt failed');
    };
    await expect(getOrLoad(NS, 'k', 1_000, failing)).rejects.toThrow('first attempt failed');
    await expect(getOrLoad(NS, 'k', 1_000, failing)).rejects.toThrow('first attempt failed');

    await expect(getOrLoad(NS, 'k', 1_000, async () => 'ok')).resolves.toBe('ok');
    await expect(getOrLoad(NS, 'k', 1_000, async () => 'not called')).resolves.toBe('ok');
  });

  it('does not cache a loader that throws synchronously', async () => {
    const thrower = (): Promise<string> => {
      throw new Error('synchronous failure');
    };

    await expect(getOrLoad(NS, 'k', 1_000, thrower)).rejects.toThrow('synchronous failure');
    await expect(getOrLoad(NS, 'k', 1_000, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('bounded size', () => {
  const CAP = 512;

  it('never grows past the per-namespace cap', async () => {
    for (let i = 0; i < CAP + 200; i += 1) {
      await getOrLoad('bounded', `key-${i}`, 60_000, async () => i);
    }
    expect(statFor('bounded')?.entries).toBe(CAP);
  });

  it('evicts the oldest write first and keeps the newest', async () => {
    for (let i = 0; i < CAP + 10; i += 1) {
      await getOrLoad('eviction', `key-${i}`, 60_000, async () => i);
    }

    // key-0 .. key-9 were written first and are gone: they load again.
    const evicted = vi.fn(async () => -1);
    await expect(getOrLoad('eviction', 'key-0', 60_000, evicted)).resolves.toBe(-1);
    expect(evicted).toHaveBeenCalledTimes(1);

    // The most recent write is still there.
    const kept = vi.fn(async () => -1);
    await expect(getOrLoad('eviction', `key-${CAP + 9}`, 60_000, kept)).resolves.toBe(CAP + 9);
    expect(kept).not.toHaveBeenCalled();
  });

  it('refreshing a key moves it to the back of the eviction order', async () => {
    // Fill to the cap, with a short TTL on the key we intend to refresh.
    await getOrLoad('refresh', 'hot', 30, async () => 'hot-v1');
    for (let i = 0; i < CAP - 1; i += 1) {
      await getOrLoad('refresh', `cold-${i}`, 60_000, async () => `cold-${i}`);
    }

    // Let `hot` expire, then reload it: it must go to the BACK of the order,
    // not stay at the front where it was first inserted.
    await sleep(45);
    await expect(getOrLoad('refresh', 'hot', 60_000, async () => 'hot-v2')).resolves.toBe('hot-v2');

    // Push the namespace over the cap; the oldest COLD keys must go, not `hot`.
    for (let i = 0; i < 20; i += 1) {
      await getOrLoad('refresh', `new-${i}`, 60_000, async () => `new-${i}`);
    }

    const stillCached = vi.fn(async () => 'reloaded');
    await expect(getOrLoad('refresh', 'hot', 60_000, stillCached)).resolves.toBe('hot-v2');
    expect(stillCached).not.toHaveBeenCalled();
  });
});

describe('resetCaches', () => {
  it('clears entries and counters', async () => {
    await getOrLoad(NS, 'k', 1_000, async () => 'v');
    await getOrLoad(NS, 'k', 1_000, async () => 'v');
    expect(statFor(NS)?.hits).toBe(1);

    resetCaches();

    expect(statFor(NS)).toEqual({ name: NS, entries: 0, hits: 0, misses: 0, hitRate: 0 });
  });

  it('stops an in-flight load from repopulating what it cleared', async () => {
    const { loader, release } = deferredLoader('stale');

    const inFlight = getOrLoad(NS, 'k', 1_000, loader);
    resetCaches();
    release();
    await inFlight;

    await expect(getOrLoad(NS, 'k', 1_000, async () => 'fresh')).resolves.toBe('fresh');
  });
});
