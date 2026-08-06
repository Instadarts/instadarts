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

/** Kept in step with the server's own PORT, so a second instance can be brought up beside a first. */
const SERVER_PORT = Number(process.env.PORT ?? 3000);
const CLIENT_PORT = Number(process.env.VITE_PORT ?? 5173);

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
    port: CLIENT_PORT,
    // Fail rather than quietly moving to the next free port. A silent slide leaves whatever was
    // already on this one serving the app, which looks like the code simply not taking effect.
    strictPort: true,
    // A scoring device is a phone on the LAN, so the dev server has to be reachable from it.
    host: true,
    // Without these the app still runs, but LiteRT silently falls back to single-threaded WASM —
    // it only opts into threads when crossOriginIsolated is true. Nothing here is cross-origin, so
    // applying them to every document costs nothing.
    headers: ISOLATION_HEADERS,
    proxy: {
      '/ws': {
        target: `ws://localhost:${SERVER_PORT}`,
        ws: true,
        // A closing WebSocket routinely aborts the socket before the proxy has finished writing to
        // it, and Vite logs the resulting ECONNABORTED/ECONNRESET as a stack trace. Every page
        // reload and every scoring device that drops off the Wi-Fi produces one, which buries the
        // errors that do mean something. The server sees the close either way.
        configure: (proxy) => {
          const expected = new Set(['ECONNABORTED', 'ECONNRESET', 'EPIPE']);
          const quiet = (err: NodeJS.ErrnoException) => {
            if (!expected.has(err.code ?? '')) console.error('[ws proxy]', err);
          };
          proxy.on('error', quiet);
          proxy.on('econnreset', quiet);
        },
      },
    },
  },
});
