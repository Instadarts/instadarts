import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';

/**
 * Serving the built client from a directory on disk — the `CLIENT_DIR` half of
 * [staticServing.ts](../../src/server/staticServing.ts), which is what every source installation
 * runs. The other half, the assets embedded in `instadarts.mjs`, is covered in
 * staticServing.test.ts by a fake request object; that fake cannot drive this half, because a
 * file served from disk is a stream rather than a `res.end(buffer)`.
 *
 * So these go over a real socket, on a real port. That is not ceremony: **the request line is the
 * thing under test.** A client library would normalise `/../SECRET.txt` away before it ever left
 * the process, and the attack this has to refuse is precisely the one that does not.
 *
 * Every assertion here is about what the server owes a browser rather than about how it is built,
 * which is what lets this file outlive the express dependency it currently exercises.
 */

let server: Server;
let port: number;
let outside: string;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), 'instadarts-client-'));
  const client = join(home, 'client');
  mkdirSync(join(client, 'assets'), { recursive: true });
  writeFileSync(join(client, 'index.html'), '<html><body>InstaDarts</body></html>');
  writeFileSync(join(client, 'assets', 'app.js'), 'console.log("hello");');
  writeFileSync(join(client, 'THIRD-PARTY-NOTICES.txt'), 'THIRD-PARTY NOTICES');

  // A file the server has no business reaching, one level above the directory it was pointed at.
  outside = join(home, 'SECRET.txt');
  writeFileSync(outside, 'TOP SECRET');

  vi.resetModules();
  vi.stubEnv('CLIENT_DIR', client);
  const express = (await import('express')).default;
  const { registerClientServing } = await import('../../src/server/staticServing');

  const app = express();
  // `null` rather than the default: this is the disk path, so say so instead of depending on the
  // build having left no embedded bundle behind.
  registerClientServing(app, null);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.resetModules();
});

interface Response {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * One request, written byte for byte.
 *
 * `requestLine` is put on the wire exactly as given — that is the whole point of not using a
 * client here — so a test can ask for a path no library would agree to send.
 */
function send(requestLine: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const extra = Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      socket.write(`${requestLine}\r\nHost: localhost\r\n${extra}Connection: close\r\n\r\n`);
    });

    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('error', reject);
    socket.on('end', () => {
      const [head, ...rest] = raw.split('\r\n\r\n');
      const [statusLine, ...headerLines] = head.split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
      }
      resolve({
        status: Number(statusLine.split(' ')[1]),
        headers,
        body: rest.join('\r\n\r\n'),
      });
    });
  });
}

describe('serving the built client from disk', () => {
  it('answers the root with index.html', async () => {
    const res = await send('GET / HTTP/1.1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toBe('<html><body>InstaDarts</body></html>');
  });

  it('serves a nested asset with a JavaScript media type', async () => {
    const res = await send('GET /assets/app.js HTTP/1.1');
    expect(res.status).toBe(200);
    // Either spelling is correct and browsers accept both, so the invariant is the media type
    // rather than which of the two names for it the server happens to use.
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toBe('console.log("hello");');
  });

  it('serves the generated notices as plain text', async () => {
    const res = await send('GET /THIRD-PARTY-NOTICES.txt HTTP/1.1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toBe('THIRD-PARTY NOTICES');
  });

  it('gives every response the cross-origin isolation headers LiteRT needs', async () => {
    // Without all three the client cannot use SharedArrayBuffer, and the model runs single-threaded
    // or not at all — so these belong on the asset as much as on the document.
    for (const path of ['/', '/assets/app.js']) {
      const res = await send(`GET ${path} HTTP/1.1`);
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    }
  });

  it('answers a client-side route with the application, not a 404', async () => {
    const res = await send('GET /match/123 HTTP/1.1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toBe('<html><body>InstaDarts</body></html>');
  });

  it('answers HEAD without a body', async () => {
    const res = await send('HEAD / HTTP/1.1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toBe('');
  });

  it('lets the client revalidate the document rather than pinning it', async () => {
    // index.html names the hashed asset files, so a browser that caches it hard never learns about
    // a new build. Whatever else changes, this one must stay revalidated.
    const res = await send('GET / HTTP/1.1');
    expect(res.headers['cache-control']).toMatch(/no-cache|max-age=0/);
  });

  describe('refuses to leave the directory it was given', () => {
    // Each of these is a real request line that a client library would have rewritten. The file
    // one level up must not come back through any of them — and "not come back" is checked on the
    // body, because a 200 carrying the secret is the failure this is looking for.
    const attacks = [
      ['a plain parent segment', 'GET /../SECRET.txt HTTP/1.1'],
      ['a percent-encoded one', 'GET /%2e%2e%2fSECRET.txt HTTP/1.1'],
      ['one buried under a real directory', 'GET /assets/../../SECRET.txt HTTP/1.1'],
      ['a doubled encoding', 'GET /..%2fSECRET.txt HTTP/1.1'],
      ['a trailing-slash variant', 'GET /assets/../../SECRET.txt/ HTTP/1.1'],
    ] as const;

    for (const [label, requestLine] of attacks) {
      it(label, async () => {
        const res = await send(requestLine);
        expect(res.body).not.toContain('TOP SECRET');
      });
    }
  });
});
