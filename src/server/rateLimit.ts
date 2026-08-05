// ============================================================
// Per-connection rate limiter (token bucket)
// ============================================================

const MAX_MSG_PER_SEC = 10;
const BUCKET_SIZE = MAX_MSG_PER_SEC;
const REFILL_RATE = MAX_MSG_PER_SEC / 1000; // tokens per ms

const buckets = new Map<string, { tokens: number; lastRefill: number }>();

export function checkRateLimit(connId: string): boolean {
  const now = Date.now();
  let bucket = buckets.get(connId);

  if (!bucket) {
    bucket = { tokens: BUCKET_SIZE, lastRefill: now };
    buckets.set(connId, bucket);
  }

  // Refill
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(BUCKET_SIZE, bucket.tokens + elapsed * REFILL_RATE);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }

  return false;
}

export function removeRateLimitBucket(connId: string): void {
  buckets.delete(connId);
}

// Clean up stale buckets periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of buckets) {
    if (now - bucket.lastRefill > 60_000) {
      buckets.delete(id);
    }
  }
}, 60_000);
