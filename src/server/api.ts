import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONFIG } from './config';
import { ApiError, createApiMatch, deleteApiMatch, getApiMatch, listApiMatches } from './apiMatches';
import { DEFAULT_FORMAT, MATCH_FIELDS } from '../shared/matchFormat';
import { allModes, describeMode } from './modes/types';
import { maxPlayersFor } from './store';

const MAX_BODY_BYTES = 16 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest();

function authenticate(req: IncomingMessage): string {
  const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (token) {
    const hash = digest(token);
    const caller = CONFIG.server.apiKeys.find(({ key }) => timingSafeEqual(hash, digest(key)));
    if (caller) return caller.id;
  }
  throw new ApiError(401, 'unauthorized', 'A valid bearer key is required');
}

/** Read without destroying the socket on overflow so the client receives a JSON error. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new ApiError(413, 'body_too_large', 'Request body exceeds 16 KiB'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError(400, 'invalid_json', 'Request body must be valid JSON')); }
    });
    req.on('error', () => reject(new ApiError(400, 'invalid_request', 'Unable to read request body')));
    req.on('aborted', () => reject(new ApiError(400, 'invalid_request', 'Request aborted')));
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * A path that exists, answered for the method asked. Anything else is a 405 naming what it does
 * take, rather than the 404 that would say the endpoint is not there at all.
 */
function methods(req: IncomingMessage, allowed: string[]): string {
  if (allowed.includes(req.method ?? '')) return req.method!;
  throw new ApiError(405, 'method_not_allowed', `Allowed methods: ${allowed.join(', ')}`, allowed);
}

/** As strict as the request body is about unknown fields, and for the same reason: a typo is a bug. */
function knownParams(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) throw new ApiError(400, 'invalid_request', `Unknown query parameter ${key}`);
  }
}

function modeCatalog() {
  return {
    modes: allModes().map((mode) => {
      const descriptor = describeMode(mode);
      return {
        ...descriptor,
        // Server-owned defaults (e.g. Whac-A-Mole's seed) are not offered for editing. Creation
        // accepts them back and ignores them, so a returned settings bag can be handed straight in.
        defaults: Object.fromEntries(mode.fields.map(({ key }) => [key, descriptor.defaults[key]])),
        effectiveMaxPlayers: maxPlayersFor(mode.id),
      };
    }),
    matchFields: MATCH_FIELDS,
    matchDefaults: DEFAULT_FORMAT,
  };
}

/** Own the API prefix, including errors, so unknown API routes never return the SPA. */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!(req.url ?? '').split('?')[0].startsWith('/api/')) return false;
  try {
    if (!CONFIG.server.apiKeys.length) throw new ApiError(404, 'not_found', 'API is disabled');
    const callerId = authenticate(req);
    const url = new URL(req.url!, 'http://localhost');
    const one = /^\/api\/v1\/matches\/([^/]+)$/.exec(url.pathname);

    if (url.pathname === '/api/v1/modes') {
      methods(req, ['GET']);
      knownParams(url, []);
      json(res, 200, modeCatalog());
    } else if (url.pathname === '/api/v1/matches') {
      knownParams(url, []);
      if (methods(req, ['GET', 'POST']) === 'GET') {
        json(res, 200, { matches: listApiMatches(callerId) });
      } else {
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
        }
        json(res, 201, createApiMatch(callerId, await readBody(req)));
      }
    } else if (one) {
      if (methods(req, ['GET', 'DELETE']) === 'DELETE') {
        // Always return history, but callers must save needed state with GET before deleting:
        // the record is gone before this response is delivered, so a lost response is unrecoverable.
        knownParams(url, []);
        json(res, 200, deleteApiMatch(callerId, one[1]));
      } else {
        knownParams(url, ['includeHistory']);
        const history = url.searchParams.get('includeHistory');
        if (history !== null && history !== 'true' && history !== 'false') {
          throw new ApiError(400, 'invalid_request', 'includeHistory must be true or false');
        }
        json(res, 200, getApiMatch(callerId, one[1], history === 'true'));
      }
    } else {
      throw new ApiError(404, 'not_found', 'Endpoint not found');
    }
  } catch (error) {
    const e = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'Unable to process request');
    if (!res.destroyed && !res.headersSent) {
      if (e.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      if (e.allow) res.setHeader('Allow', e.allow.join(', '));
      json(res, e.status, { error: { code: e.code, message: e.message } });
    }
    req.resume();
  }
  return true;
}
