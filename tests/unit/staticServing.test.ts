import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { getMimeType, getEmbeddedAssets } from '../../src/server/embeddedAssets';
import { createClientServing } from '../../src/server/staticServing';
import { probe, type Probe } from './rawHttp';

describe('embeddedAssets', () => {
  it('identifies MIME types correctly', () => {
    expect(getMimeType('index.html')).toBe('text/html; charset=utf-8');
    expect(getMimeType('assets/style.css')).toBe('text/css; charset=utf-8');
    expect(getMimeType('assets/script.js')).toBe('application/javascript; charset=utf-8');
    expect(getMimeType('wasm/runtime.wasm')).toBe('application/wasm');
    expect(getMimeType('models/model.tflite')).toBe('application/octet-stream');
    expect(getMimeType('images/board.jpg')).toBe('image/jpeg');
    expect(getMimeType('THIRD-PARTY-NOTICES.txt')).toBe('text/plain; charset=utf-8');
  });

  it('returns null on null bundle', () => {
    expect(getEmbeddedAssets(null)).toBeNull();
  });

  it('decompresses and extracts assets from a valid bundle', () => {
    const rawMap = {
      'index.html': Buffer.from('<!doctype html><html><body>Test</body></html>').toString('base64'),
      'wasm/test.wasm': Buffer.from([0x00, 0x61, 0x73, 0x6d]).toString('base64'),
    };
    const json = JSON.stringify(rawMap);
    const compressed = gzipSync(Buffer.from(json, 'utf-8')).toString('base64');

    const assets = getEmbeddedAssets(compressed);
    expect(assets).not.toBeNull();
    expect(assets?.has('/index.html')).toBe(true);
    expect(assets?.get('/index.html')?.contentType).toBe('text/html; charset=utf-8');
    expect(assets?.get('/index.html')?.data.toString('utf-8')).toBe('<!doctype html><html><body>Test</body></html>');
    expect(assets?.get('/index.html')?.etag).toMatch(/^"[a-f0-9]{16}"$/);

    expect(assets?.has('/wasm/test.wasm')).toBe(true);
    expect(assets?.get('/wasm/test.wasm')?.contentType).toBe('application/wasm');
  });
});

/**
 * The same client, embedded in the program rather than sitting in a directory beside it — what
 * `instadarts.mjs` carries. Driven over a socket by the same harness as the disk half in
 * staticServingDisk.test.ts, and asserting the same things, because **a browser must not be able
 * to tell the two apart.** Where these two files disagree, one of the two deployments is wrong.
 */
describe('serving the built client from the embedded bundle', () => {
  let http: Probe;

  beforeAll(async () => {
    const rawMap = {
      'index.html': Buffer.from('<html><body>InstaDarts</body></html>').toString('base64'),
      'assets/app.js': Buffer.from('console.log("hello");').toString('base64'),
      'THIRD-PARTY-NOTICES.txt': Buffer.from('THIRD-PARTY NOTICES').toString('base64'),
    };
    const compressed = gzipSync(Buffer.from(JSON.stringify(rawMap), 'utf-8')).toString('base64');
    http = await probe(createClientServing(getEmbeddedAssets(compressed))!);
  });

  afterAll(async () => { await http.close(); });

  it('answers the root with index.html', async () => {
    const res = await http.send('GET / HTTP/1.1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toBe('<html><body>InstaDarts</body></html>');
  });

  it('serves a nested asset with a JavaScript media type', async () => {
    const res = await http.send('GET /assets/app.js HTTP/1.1');
    expect(res.status).toBe(200);
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
    const res = await http.send('GET / HTTP/1.1');
    expect(res.headers['cache-control']).toMatch(/no-cache|max-age=0/);
  });

  it('lets the client keep a hashed asset without asking again', async () => {
    // The bundler puts the content hash in the name, so a cached copy can never be the wrong one.
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

  it('answers a missing file with 404 rather than the application', async () => {
    // The divergence this replaced: the disk path used to fall back to index.html here, so a
    // browser asking for a script got HTML and reported a parse error instead of the 404 that
    // actually happened. A path with an extension is asking for a file, not for a route.
    const res = await http.send('GET /assets/missing.js HTTP/1.1');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('InstaDarts');
  });
});
