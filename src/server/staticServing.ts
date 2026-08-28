import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getEmbeddedAssets, getMimeType, type EmbeddedAsset } from './embeddedAssets';
import { CLIENT_DIR } from './env';

/**
 * Serving the built client, from wherever this run keeps it.
 *
 * Two sources, one set of rules. The assets can be embedded in `instadarts.mjs`, or they can be a
 * directory on disk that a source installation built — and a browser should not be able to tell
 * which it is talking to. Everything that decides *what* to answer (which path is an application
 * route, how long a thing may be cached, what a missing file means) is therefore shared below;
 * only the reading of the bytes differs.
 */

/** Answers the request, or returns false to say it is not ours and something else should. */
export type ClientRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

/**
 * Required for `SharedArrayBuffer`, which LiteRT's multithreaded WASM runtime needs. All three or
 * none: a document missing any one of them loses cross-origin isolation and the model drops to a
 * single thread, or fails to start.
 *
 * On client responses only, which is where they mean something. `/server-stats` never carried them
 * and does not need them.
 *
 * `ISOLATION_HEADERS` in `vite.config.ts` is the development half of this and holds the same three.
 * A client response should not be able to tell which server built it, headers included.
 */
const ISOLATION: ReadonlyArray<readonly [string, string]> = [
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
];

/**
 * How long the client may keep a thing without asking again.
 *
 * `/assets/` earns a year because the bundler puts a hash of the contents in the filename: new
 * bytes arrive under a new name, so a cached copy can never be the wrong one. Nothing else here
 * has that property — `/wasm/` and `/models/` are copied in under fixed names, and an upgrade
 * would leave a browser holding last release's runtime for a year — so everything else revalidates
 * and pays one conditional request, which an ETag turns into a 304.
 */
function cacheControl(pathname: string): string {
  return pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

/**
 * Whether a path that matched no file is a client-side route rather than a typo.
 *
 * A route gets the application and lets the router sort it out. Anything with a file extension
 * does not: answering `/assets/missing.js` with HTML gives the browser a script that is not one,
 * and it reports the resulting parse error instead of the 404 that actually happened.
 */
function isApplicationRoute(pathname: string): boolean {
  if (pathname === '/ws' || pathname.startsWith('/ws/')) return false;
  if (pathname === '/server-stats') return false;
  return !/\.[a-zA-Z0-9]+$/.test(pathname);
}

/**
 * The path being asked for, or `null` if the request is not asking for one.
 *
 * Decoded, because `%2e%2e%2f` and `../` are the same request and only one of them looks like it.
 * A malformed escape is a bad request rather than something to guess at.
 */
function requestedPath(req: IncomingMessage): string | null {
  const raw = (req.url ?? '').split('?')[0];
  let pathname: string;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!pathname.startsWith('/')) return null;
  return pathname === '/' ? '/index.html' : pathname;
}

function serveHead(req: IncomingMessage): boolean {
  return req.method === 'HEAD';
}

function readable(req: IncomingMessage): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

/** Sends the headers every client response carries, whatever it turned out to be. */
function beginResponse(res: ServerResponse, pathname: string, contentType: string, etag: string) {
  for (const [name, value] of ISOLATION) res.setHeader(name, value);
  res.setHeader('Content-Type', contentType);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', cacheControl(pathname));
}

function notModified(res: ServerResponse): true {
  for (const [name, value] of ISOLATION) res.setHeader(name, value);
  res.statusCode = 304;
  res.end();
  return true;
}

/** The client as a dictionary in memory: what `instadarts.mjs` carries inside itself. */
function serveEmbedded(assets: Map<string, EmbeddedAsset>): ClientRequestHandler {
  const send = (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    asset: EmbeddedAsset,
  ): true => {
    if (req.headers['if-none-match'] === asset.etag) return notModified(res);

    beginResponse(res, pathname, asset.contentType, asset.etag);
    res.setHeader('Content-Length', asset.data.length);
    res.statusCode = 200;
    res.end(serveHead(req) ? undefined : asset.data);
    return true;
  };

  return async (req, res) => {
    if (!readable(req)) return false;
    const pathname = requestedPath(req);
    if (pathname === null) return false;

    const asset = assets.get(pathname);
    if (asset) return send(req, res, pathname, asset);

    if (!isApplicationRoute(pathname)) return false;
    const index = assets.get('/index.html');
    return index ? send(req, res, '/index.html', index) : false;
  };
}

/**
 * The client as files in a directory: what a source installation built into `dist/client`.
 *
 * The one thing this must never do is answer with a file outside that directory. Every path is
 * resolved against the root and then checked to still be under it, after decoding — which is the
 * only order that catches an escape spelled as `%2e%2e`.
 */
function serveDirectory(dir: string): ClientRequestHandler {
  const root = resolve(dir);
  const prefix = root + sep;

  /** The file this path names, or `null` if it names none — or names one it may not have. */
  const locate = (pathname: string): string | null => {
    const full = resolve(root, '.' + pathname);
    return full === root || full.startsWith(prefix) ? full : null;
  };

  const send = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    file: string,
  ): Promise<boolean> => {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return false;

    // Size and modification time, which change together whenever the bytes do. Hashing the
    // contents would be exact and would also mean reading a 20MB runtime to answer a conditional
    // request for it.
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) return notModified(res);

    beginResponse(res, pathname, getMimeType(pathname), etag);
    res.setHeader('Content-Length', info.size);
    res.statusCode = 200;

    if (serveHead(req)) {
      res.end();
      return true;
    }

    await new Promise<void>((done) => {
      const stream = createReadStream(file);
      // The headers are already out by the time a read can fail, so there is no status left to
      // send. Dropping the response is the only honest ending: a truncated body against a stated
      // Content-Length is what tells the client it did not get the whole file.
      stream.on('error', () => { res.destroy(); done(); });
      stream.on('end', () => done());
      stream.pipe(res);
    });
    return true;
  };

  return async (req, res) => {
    if (!readable(req)) return false;
    const pathname = requestedPath(req);
    if (pathname === null) return false;

    const file = locate(pathname);
    if (file && await send(req, res, pathname, file)) return true;

    if (!isApplicationRoute(pathname)) return false;
    const index = locate('/index.html');
    return index ? await send(req, res, '/index.html', index) : false;
  };
}

/**
 * The handler for this run's *built* client, or `null` for a run that has none.
 *
 * `null` is what `npm run dev` gets: its client is Vite's, mounted in the same process by
 * `devClient.ts` and built on demand, and this server also answering with whatever `dist/client`
 * happens to hold would be two answers to one question, one of them stale.
 *
 * Passing `customAssets` says which source to use rather than letting the build decide — `null`
 * for the directory, a map for the embedded case. Tests use it to reach a path the build they run
 * under would not have given them.
 */
export function createClientServing(
  customAssets?: Map<string, EmbeddedAsset> | null,
): ClientRequestHandler | null {
  const embedded = customAssets !== undefined ? customAssets : getEmbeddedAssets();
  if (embedded) return serveEmbedded(embedded);
  if (CLIENT_DIR) return serveDirectory(CLIENT_DIR);
  return null;
}
