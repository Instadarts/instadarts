import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONFIG } from './config';
import { ApiError, createApiMatch, getApiMatch } from './apiMatches';

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

/** Own the API prefix, including errors, so unknown API routes never return the SPA. */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!(req.url ?? '').split('?')[0].startsWith('/api/')) return false;
  try {
    if (!CONFIG.server.apiKeys.length) throw new ApiError(404, 'not_found', 'API is disabled');
    const callerId = authenticate(req);
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/api/v1/matches' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
      }
      const body = await readBody(req);
      json(res, 201, createApiMatch(callerId, body));
    } else {
      const match = /^\/api\/v1\/matches\/([^/]+)$/.exec(url.pathname);
      if (!match || req.method !== 'GET') throw new ApiError(404, 'not_found', 'Endpoint not found');
      const history = url.searchParams.get('includeHistory');
      if (history !== null && history !== 'true' && history !== 'false') {
        throw new ApiError(400, 'invalid_request', 'includeHistory must be true or false');
      }
      json(res, 200, getApiMatch(callerId, match[1], history === 'true'));
    }
  } catch (error) {
    const e = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'Unable to process request');
    if (!res.destroyed && !res.headersSent) {
      if (e.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      json(res, e.status, { error: { code: e.code, message: e.message } });
    }
    req.resume();
  }
  return true;
}
