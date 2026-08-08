// What kind of build this is.
//
// One definition, because "am I in production" decided in two places is a thing that eventually
// disagrees with itself. Read once at boot: nothing changes NODE_ENV while the server runs.

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** A development build: `npm run dev`, and the test runner. Anything that is not `npm start`. */
export const IS_DEV = !IS_PRODUCTION;

/**
 * Say nothing about connections and modes on startup. Set by the e2e run, where a line per client
 * buries the output that is actually about a test.
 */
export const QUIET = process.env.QUIET === '1';
