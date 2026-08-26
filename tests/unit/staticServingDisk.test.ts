import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe, type Probe } from './rawHttp';

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
 * which is what let this file outlive express, the dependency it was first written against.
 */

let http: Probe;
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
  const { createClientServing } = await import('../../src/server/staticServing');

  // `null` rather than the default: this is the disk path, so say so instead of depending on the
  // build having left no embedded bundle behind.
  http = await probe(createClientServing(null)!);
});

afterAll(async () => {
  await http.close();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('serving the built client from disk', () => {
  it('answers the root with index.html', async () => {
    const res = await http.send('GET / HTTP/1.1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toBe('<html><body>InstaDarts</body></html>');
  });

  it('serves a nested asset with a JavaScript media type', async () => {
    const res = await http.send('GET /assets/app.js HTTP/1.1');
    expect(res.status).toBe(200);
    // Either spelling is correct and browsers accept both, so the invariant is the media type
    // rather than which of the two names for it the server happens to use.
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toBe('console.log("hello");');
  });

  it('serves the generated notices as plain text', async () => {
    const res = await http.send('GET /THIRD-PARTY-NOTICES.txt HTTP/1.1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toBe('THIRD-PARTY NOTICES');
  });

  it('gives every response the cross-origin isolation headers LiteRT needs', async () => {
    // Without all three the client cannot use SharedArrayBuffer, and the model runs single-threaded
    // or not at all — so these belong on the asset as much as on the document.
    for (const path of ['/', '/assets/app.js']) {
      const res = await http.send(`GET ${path} HTTP/1.1`);
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    }
  });

  it('answers a client-side route with the application, not a 404', async () => {
    const res = await http.send('GET /match/123 HTTP/1.1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toBe('<html><body>InstaDarts</body></html>');
  });

  it('answers HEAD without a body', async () => {
    const res = await http.send('HEAD / HTTP/1.1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toBe('');
  });

  it('lets the client revalidate the document rather than pinning it', async () => {
    // index.html names the hashed asset files, so a browser that caches it hard never learns about
    // a new build. Whatever else changes, this one must stay revalidated.
    const res = await http.send('GET / HTTP/1.1');
    expect(res.headers['cache-control']).toMatch(/no-cache|max-age=0/);
  });


  it('answers a missing file with 404 rather than the application', async () => {
    // The divergence this replaced: the disk path used to fall back to index.html here, so a
    // browser asking for a script got HTML and reported a parse error instead of the 404 that
    // actually happened. A path with an extension is asking for a file, not for a route.
    const res = await http.send('GET /assets/missing.js HTTP/1.1');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('InstaDarts');
  });

  it('lets the client keep a hashed asset without asking again', async () => {
    const res = await http.send('GET /assets/app.js HTTP/1.1');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('answers a repeat request for an unchanged file with 304', async () => {
    const first = await http.send('GET / HTTP/1.1');
    expect(first.headers['etag']).toBeDefined();
    const second = await http.send('GET / HTTP/1.1', { 'If-None-Match': first.headers['etag'] });
    expect(second.status).toBe(304);
    expect(second.body).toBe('');
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
        const res = await http.send(requestLine);
        expect(res.body).not.toContain('TOP SECRET');
      });
    }
  });
});
