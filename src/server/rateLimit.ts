// ============================================================
// Per-connection rate limiter (token bucket)
// ============================================================

const MAX_MSG_PER_SEC = 10;
/**
 * Tips get their own, larger budget: they are published by a motion-gated camera rather than by a
 * person, and the report that would be dropped is as likely as not the empty one that ends a visit.
 */
const MAX_TIPS_PER_SEC = 30;

const buckets = new Map<string, { tokens: number; lastRefill: number }>();
const tipsBuckets = new Map<string, { tokens: number; lastRefill: number }>();

export function checkRateLimit(connId: string): boolean {
  return take(buckets, connId, MAX_MSG_PER_SEC);
}

export function checkTipsRateLimit(deviceId: string): boolean {
  return take(tipsBuckets, deviceId, MAX_TIPS_PER_SEC);
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

export function removeRateLimitBucket(connId: string): void {
  buckets.delete(connId);
  tipsBuckets.delete(connId);
}

// Clean up stale buckets periodically
setInterval(() => {
  const now = Date.now();
  for (const store of [buckets, tipsBuckets]) {
    for (const [id, bucket] of store) {
      if (now - bucket.lastRefill > 60_000) {
        store.delete(id);
      }
    }
  }
}, 60_000);
