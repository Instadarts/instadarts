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
