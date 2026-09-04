// ============================================================
// Per-connection rate limiter (token bucket)
// ============================================================

/**
 * A token bucket has two numbers, and this file used to give it one.
 *
 * The **refill rate** is the flood control: what a client may keep up indefinitely. The **burst** is
 * the allowance it may spend at once after being quiet. Setting them equal left no burst allowance
 * at all — a connection silent for an hour still had ten messages before it was throttled — so the
 * figure meant to stop a flood was also the figure deciding whether an ordinary flurry got through,
 * and the flurry was the one that lost.
 *
 * The bursts below are sized on measurement rather than on the sustained rate. Logging every inbound
 * message through a full end-to-end run: a page arriving in a room sends **four** of its own accord,
 * and the busiest second anywhere was **twelve** — a test doing in under a second what a person does
 * over half a minute of typing names and choosing settings. Nothing a person or the interface can do
 * comes near these, which is the point: reaching one is evidence of a broken or hostile client
 * rather than a quick one, and `wsHandler` answers it as such.
 */
interface Budget {
  /** What may be spent at once, after being quiet. Sized so no honest client can reach it. */
  burst: number;
  /** What may be kept up indefinitely. This is the flood control. */
  perSecond: number;
}

/** Everything a frontend or a device says that is not media or tips — gameplay included. */
const GENERAL: Budget = { burst: 60, perSecond: 10 };

/**
 * Tips get their own, larger budget: they are published by a motion-gated camera rather than by a
 * person, and the report that would be dropped is as likely as not the empty one that ends a visit.
 */
const TIPS: Budget = { burst: 90, perSecond: 30 };

/**
 * The media plane gets its own too, for the opposite reason to tips: not because it is chatty, but
 * because it arrives in bursts. A peer connection takes one offer and one answer — a link's whole
 * signaling life — so a client joining a match negotiates every link it has at once and then says
 * nothing for the rest of the evening. Spending that from the general bucket would cost it the
 * gameplay messages it sends in the same second, which is what it was doing: `media_join` appeared
 * in nearly every one of the busiest seconds measured, beside the darts it was competing with.
 */
const MEDIA: Budget = { burst: 60, perSecond: 20 };

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();
const tipsBuckets = new Map<string, Bucket>();
const mediaBuckets = new Map<string, Bucket>();

export function checkRateLimit(connId: string): boolean {
  return take(buckets, connId, GENERAL);
}

export function checkTipsRateLimit(deviceId: string): boolean {
  return take(tipsBuckets, deviceId, TIPS);
}

/** Keyed by whichever identity this connection has — a frontend's session, a device's id. */
export function checkMediaRateLimit(id: string): boolean {
  return take(mediaBuckets, id, MEDIA);
}

function take(store: Map<string, Bucket>, id: string, { burst, perSecond }: Budget): boolean {
  const now = Date.now();
  let bucket = store.get(id);

  if (!bucket) {
    bucket = { tokens: burst, lastRefill: now };
    store.set(id, bucket);
  }

  // Refill at the sustained rate, up to the burst allowance — the two are not the same number.
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(burst, bucket.tokens + (elapsed * perSecond) / 1000);
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
  mediaBuckets.delete(deviceId ?? sessionId);
  if (deviceId) tipsBuckets.delete(deviceId);
}

// A bucket is one number and a timestamp, and an untouched one is indistinguishable from a fresh
// one — so anything idle for a minute is dropped rather than tracked to its owner's disconnection.
setInterval(() => {
  const now = Date.now();
  for (const store of [buckets, tipsBuckets, mediaBuckets]) {
    for (const [id, bucket] of store) {
      if (now - bucket.lastRefill > 60_000) {
        store.delete(id);
      }
    }
  }
}, 60_000);
