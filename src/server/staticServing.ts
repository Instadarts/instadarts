import express from 'express';
import { getEmbeddedAssets, type EmbeddedAsset } from './embeddedAssets';
import { CLIENT_DIR } from './env';

/**
 * Registers client serving on the Express application.
 *
 * Serving priority:
 * 1. Embedded assets (if compiled into instadarts.mjs for a standalone release)
 * 2. Filesystem directory (`CLIENT_DIR` in unbundled production runs)
 * 3. None (in `npm run dev`, where Vite handles the client on port 5173)
 */
export function registerClientServing(app: express.Express, customAssets?: Map<string, EmbeddedAsset> | null): void {
  const embeddedAssets = customAssets !== undefined ? customAssets : getEmbeddedAssets();

  if (embeddedAssets) {
    // Cross-origin isolation headers required for LiteRT multithreading in WASM
    app.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      next();
    });

    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return next();
      }

      const pathname = (req.url ?? '').split('?')[0];
      const targetPath = pathname === '/' || pathname === '' ? '/index.html' : pathname;

      const asset = embeddedAssets.get(targetPath);
      if (asset) {
        if (req.headers['if-none-match'] === asset.etag) {
          res.status(304).end();
          return;
        }

        res.setHeader('Content-Type', asset.contentType);
        res.setHeader('Content-Length', asset.data.length);
        res.setHeader('ETag', asset.etag);

        if (targetPath.startsWith('/assets/') || targetPath.startsWith('/wasm/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }

        if (req.method === 'HEAD') {
          res.status(200).end();
          return;
        }

        res.status(200).end(asset.data);
        return;
      }

      // If this is an SPA navigation (not an API or WS route and not a request for a missing asset file with extension)
      const isApiOrWs = pathname === '/ws' || pathname.startsWith('/ws/') || pathname === '/server-stats';
      const hasFileExtension = /\.[a-zA-Z0-9]+$/.test(pathname);

      if (!isApiOrWs && !hasFileExtension) {
        const indexAsset = embeddedAssets.get('/index.html');
        if (indexAsset) {
          if (req.headers['if-none-match'] === indexAsset.etag) {
            res.status(304).end();
            return;
          }

          res.setHeader('Content-Type', indexAsset.contentType);
          res.setHeader('Content-Length', indexAsset.data.length);
          res.setHeader('ETag', indexAsset.etag);
          res.setHeader('Cache-Control', 'no-cache');

          if (req.method === 'HEAD') {
            res.status(200).end();
            return;
          }

          res.status(200).end(indexAsset.data);
          return;
        }
      }

      next();
    });
    return;
  }

  // Fallback: serve from filesystem if CLIENT_DIR is specified
  if (CLIENT_DIR) {
    const clientDir = CLIENT_DIR;
    app.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      next();
    });
    app.use(express.static(clientDir));
    // SPA fallback: serve index.html for all non-API routes
    app.get('/{*splat}', (_req, res) => {
      res.sendFile('index.html', { root: clientDir });
    });
  }
}
