import { cpSync, createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// LiteRT loads its WASM runtime from /wasm/ at runtime (src/client/vision/model.js). Those files
// ship inside the npm package, so rather than committing a copy into public/ they are served
// straight out of node_modules in dev and copied once at build.
const wasmDir = fileURLToPath(new URL('./node_modules/@litertjs/core/wasm/', import.meta.url));

/** Cross-origin isolation → SharedArrayBuffer → LiteRT's threaded WASM build. */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function litertWasm(): Plugin {
  return {
    name: 'litert-wasm',
    configureServer(server) {
      server.middlewares.use('/wasm', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0]?.replace(/^\//, '');
        if (!name || name.includes('..')) return next();
        const file = wasmDir + name;
        if (!existsSync(file)) return next();

        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        // LiteRT's threaded build starts a worker from this directory. In a cross-origin isolated
        // document the worker script must carry the isolation headers itself, or Chrome blocks it
        // with ERR_BLOCKED_BY_RESPONSE and model loading hangs forever with no error.
        for (const [header, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(header, value);
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      cpSync(wasmDir, fileURLToPath(new URL('./dist/client/wasm/', import.meta.url)), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), litertWasm()],
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
    },
  },
  root: 'src/client',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // A scoring device is a phone on the LAN, so the dev server has to be reachable from it.
    host: true,
    // Without these the app still runs, but LiteRT silently falls back to single-threaded WASM —
    // it only opts into threads when crossOriginIsolated is true. Nothing here is cross-origin, so
    // applying them to every document costs nothing.
    headers: ISOLATION_HEADERS,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
