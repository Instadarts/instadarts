// ============================================================
// Per-connection rate limiter (token bucket)
// ============================================================

const MAX_MSG_PER_SEC = 10;
/**
 * Tips get their own, larger budget: they are published by a motion-gated camera rather than by a
 * person, and the report that would be dropped is as likely as not the empty one that ends a visit.
 */
const MAX_TIPS_PER_SEC = 30;
/**
 * Signaling gets its own budget too, for the opposite reason to tips: not because it is chatty, but
 * because it arrives in bursts. A peer connection takes one offer and one answer — a link's whole
 * signaling life — so a client joining a match negotiates every link it has at once and then says
 * nothing for the rest of the evening. Spending that from the shared bucket would cost it the
 * gameplay messages it sends in the same second.
 */
const MAX_SIGNALS_PER_SEC = 20;

const buckets = new Map<string, { tokens: number; lastRefill: number }>();
const tipsBuckets = new Map<string, { tokens: number; lastRefill: number }>();
const signalBuckets = new Map<string, { tokens: number; lastRefill: number }>();

export function checkRateLimit(connId: string): boolean {
  return take(buckets, connId, MAX_MSG_PER_SEC);
}

export function checkTipsRateLimit(deviceId: string): boolean {
  return take(tipsBuckets, deviceId, MAX_TIPS_PER_SEC);
}

/** Keyed by whichever identity this connection has — a frontend's session, a device's id. */
export function checkSignalRateLimit(id: string): boolean {
  return take(signalBuckets, id, MAX_SIGNALS_PER_SEC);
}

function take(store: Map<string, { tokens: number; lastRefill: number }>, id: string, perSec: number): boolean {
  const now = Date.now();
  let bucket = store.get(id);

  if (!bucket) {
    bucket = { tokens: perSec, lastRefill: now };
    store.set(id, bucket);
  }

  // Refill
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(perSec, bucket.tokens + (elapsed * perSec) / 1000);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }

  return false;
}

/**
 * Give back what a departing connection was spending from.
 *
 * The two budgets are keyed differently — a frontend by its session, a scoring device by its
 * device — so both are named here rather than assuming one key fits both.
 *
 * Not load bearing: the sweep below reclaims an idle bucket within a minute whatever happens, which
 * is what covers a connection that never says goodbye. This just does not wait for it.
 */
export function releaseRateLimit(sessionId: string, deviceId: string | null): void {
  buckets.delete(sessionId);
  signalBuckets.delete(deviceId ?? sessionId);
  if (deviceId) tipsBuckets.delete(deviceId);
}

// A bucket is one number and a timestamp, and an untouched one is indistinguishable from a fresh
// one — so anything idle for a minute is dropped rather than tracked to its owner's disconnection.
setInterval(() => {
  const now = Date.now();
  for (const store of [buckets, tipsBuckets, signalBuckets]) {
    for (const [id, bucket] of store) {
      if (now - bucket.lastRefill > 60_000) {
        store.delete(id);
      }
    }
  }
}, 60_000);
