// What kind of run this is.
//
// Not what the deployment is *tuned* to — that is config.ts, and one optional file. This module
// holds only what describes the run itself and is already settled by the time a file could be read:
// whether this is a production build, whether it should keep quiet, and where its client is.
//
// One definition each, because "am I in production" decided in two places is a thing that
// eventually disagrees with itself. Read once at boot: nothing here changes while the server runs.

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** A development build: `npm run dev`, and the test runner. Anything that is not `npm start`. */
export const IS_DEV = !IS_PRODUCTION;

/**
 * The directory the built client is served from, or `null` for a run that serves no client at all.
 *
 * `npm run dev` is the null case: Vite serves the client on its own port, and this server also
 * answering with whatever `dist/client` happens to hold would be two answers to the same question —
 * one of them stale. `npm start` serves the build sitting next to it.
 *
 * A deployment whose client is somewhere else names it: `CLIENT_DIR=/srv/instadarts/client`. Naming
 * it is also what asks for it to be served, which is what lets a run be a development one and still
 * serve a client.
 */
export const CLIENT_DIR: string | null =
  process.env.CLIENT_DIR ?? (IS_PRODUCTION ? 'dist/client' : null);

/**
 * Say nothing about connections and modes on startup. Set by the e2e run, where a line per client
 * buries the output that is actually about a test.
 */
export const QUIET = process.env.QUIET === '1';

