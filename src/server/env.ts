// What kind of run this is, and how big it is allowed to get.
//
// One definition each, because "am I in production" decided in two places is a thing that
// eventually disagrees with itself. Read once at boot: nothing here changes while the server runs.

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** A development build: `npm run dev`, and the test runner. Anything that is not `npm start`. */
export const IS_DEV = !IS_PRODUCTION;

/**
 * Say nothing about connections and modes on startup. Set by the e2e run, where a line per client
 * buries the output that is actually about a test.
 */
export const QUIET = process.env.QUIET === '1';

/**
 * How many matches this deployment is sized for — the one number that scales the server.
 *
 * Everything else the server refuses or evicts by is derived from it in capacity.ts, so this is the
 * only figure to change: `MAX_MATCHES=50000 npm start`. Anything that is not a positive whole
 * number is ignored rather than believed, because a `NaN` here would silently disable every limit
 * that divides from it.
 */
const DEFAULT_MAX_MATCHES = 10_000;

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const MAX_MATCHES = positiveIntFromEnv(process.env.MAX_MATCHES, DEFAULT_MAX_MATCHES);

/**
 * Whether this deployment carries video and stills between the devices in a match.
 *
 * Optional in the strongest sense: off, the server mints no peer ids, publishes no rosters, relays
 * no signals and answers every media message with silence, and neither frontend shows a thing. It
 * is one flag rather than a scattering of checks because a feature that can be half-on is a feature
 * nobody can reason about.
 *
 * `MEDIA=0 npm start` turns it off. Note this is the *deployment's* answer; a browser or a phone may
 * still opt out for itself, which it does by never announcing itself rather than by a second flag.
 */
const DEFAULT_MEDIA_ENABLED = true;

/** Anything that is not a recognised boolean is ignored rather than guessed at. */
function boolFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false;
  if (value === '1' || value === 'true' || value === 'on' || value === 'yes') return true;
  return fallback;
}

export const MEDIA_ENABLED = boolFromEnv(process.env.MEDIA, DEFAULT_MEDIA_ENABLED);

/**
 * STUN servers the clients should use, comma-separated. **Empty by default**, which means host
 * candidates only: a scoring device reaches its own frontend across the room, and an opponent in
 * another house reaches nobody.
 *
 * That is a deliberate default rather than an oversight — nothing about a match should leave the
 * deployment unless somebody asked for it. `MEDIA_ICE_URLS=stun:stun.example.org:19302 npm start`
 * is the one change that opens it up. There is no TURN: where a peer connection cannot be made, the
 * feature is simply unavailable to that user.
 */
function iceUrlsFromEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((url) => url.trim())
    // Only the two schemes a STUN or TURN URL can have. A typo becomes no server rather than a
    // client that throws on `new RTCPeerConnection`.
    .filter((url) => /^stuns?:|^turns?:/.test(url));
}

export const MEDIA_ICE_URLS = iceUrlsFromEnv(process.env.MEDIA_ICE_URLS);
