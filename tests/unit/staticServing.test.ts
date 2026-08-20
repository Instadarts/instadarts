import { describe, it, expect } from 'vitest';
import express from 'express';
import { gzipSync } from 'node:zlib';
import { getMimeType, getEmbeddedAssets } from '../../src/server/embeddedAssets';
import { registerClientServing } from '../../src/server/staticServing';

describe('embeddedAssets', () => {
  it('identifies MIME types correctly', () => {
    expect(getMimeType('index.html')).toBe('text/html; charset=utf-8');
    expect(getMimeType('assets/style.css')).toBe('text/css; charset=utf-8');
    expect(getMimeType('assets/script.js')).toBe('application/javascript; charset=utf-8');
    expect(getMimeType('wasm/runtime.wasm')).toBe('application/wasm');
    expect(getMimeType('models/model.tflite')).toBe('application/octet-stream');
    expect(getMimeType('images/board.jpg')).toBe('image/jpeg');
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

describe('staticServing', () => {
  it('serves embedded assets with isolation and caching headers', async () => {
    const rawMap = {
      'index.html': Buffer.from('<html><body>InstaDarts</body></html>').toString('base64'),
      'assets/app.js': Buffer.from('console.log("hello");').toString('base64'),
    };
    const json = JSON.stringify(rawMap);
    const compressed = gzipSync(Buffer.from(json, 'utf-8')).toString('base64');

    const assets = getEmbeddedAssets(compressed);

    const app = express();
    registerClientServing(app, assets);

    // Test GET /
    const rootRes = await simulateRequest(app, 'GET', '/');
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(rootRes.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(rootRes.headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(rootRes.headers['cache-control']).toBe('no-cache');
    expect(rootRes.body.toString('utf-8')).toBe('<html><body>InstaDarts</body></html>');

    // Test ETag / 304 Not Modified
    const etag = rootRes.headers['etag'];
    expect(etag).toBeDefined();
    const notModifiedRes = await simulateRequest(app, 'GET', '/', { 'if-none-match': etag });
    expect(notModifiedRes.status).toBe(304);

    // Test GET /assets/app.js (immutable cache)
    const assetRes = await simulateRequest(app, 'GET', '/assets/app.js');
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(assetRes.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(assetRes.body.toString('utf-8')).toBe('console.log("hello");');

    // Test SPA fallback for route /match/123
    const spaRes = await simulateRequest(app, 'GET', '/match/123');
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(spaRes.body.toString('utf-8')).toBe('<html><body>InstaDarts</body></html>');
  });
});

async function simulateRequest(
  app: express.Express,
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req: any = {
      method,
      url,
      headers: { ...headers },
      path: url.split('?')[0],
    };

    const resHeaders: Record<string, string> = {};
    let statusCode = 200;
    const chunks: Buffer[] = [];

    const res: any = {
      setHeader(name: string, value: string) {
        resHeaders[name.toLowerCase()] = value;
      },
      status(code: number) {
        statusCode = code;
        return this;
      },
      end(chunk?: any) {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        resolve({
          status: statusCode,
          headers: resHeaders,
          body: Buffer.concat(chunks),
        });
      },
    };

    app(req, res, (err?: any) => {
      if (err) return reject(err);
      resolve({
        status: 404,
        headers: resHeaders,
        body: Buffer.concat(chunks),
      });
    });
  });
}
