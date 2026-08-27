import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// The `.ts` is load-bearing: Vite's default config loader bundles this file and would resolve the
// path without it, but `--configLoader native` hands the file to Node, which does not guess
// extensions. It also means palette.ts must stay erasable — Node strips types rather than compiling
// them, so an enum or a parameter property there breaks config loading — and its Mantine import
// must stay `import type`, or loading this config pulls in the browser bundle.
import { appPalette } from './src/client/layout/palette.ts';

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

/**
 * Suppress the [vite] ws proxy error / ws proxy socket error noise that Vite 8 logs internally
 * before user-defined proxy error handlers get to process them. Every page reload, every scoring
 * device that drops off the Wi-Fi, and every e2e test browser close produces one — they are
 * expected and the server sees the close either way.
 */
/**
 * `/favicon.svg`, wrapped around the one copy of the mark.
 *
 * The mark is authored once, in `src/client/components/mark.svg`, in `currentColor` so the wordmark
 * can tint it. A tab icon has no colour to inherit and no page behind it, so this adds the two
 * things it needs — a ground and a colour — around exactly those shapes rather than around a second
 * drawing of them. Served in dev and written once at build, the same way the LiteRT WASM is.
 */
const markFile = fileURLToPath(new URL('./src/client/components/mark.svg', import.meta.url));

function favicon(): Plugin {
  const render = () => {
    // Comments go first: mark.svg documents this wrapper, so its prose mentions the tags being
    // looked for and a naive search lands inside the explanation rather than on the element.
    const mark = readFileSync(markFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const shapes = mark.slice(mark.indexOf('>', mark.indexOf('<svg')) + 1, mark.lastIndexOf('</svg>'));
    // The box comes from the mark rather than being assumed, so redrawing it at another scale does
    // not silently produce a tab icon with the artwork in one corner.
    const box = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(mark);
    if (!box) throw new Error('mark.svg has no "0 0 w h" viewBox to build a favicon from');
    const [width, height] = [Number(box[1]), Number(box[2])];
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`,
      `<rect width="${width}" height="${height}" rx="${round(width * 0.23)}" fill="${ground}"/>`,
      `<g color="${accent}">${shapes.trim()}</g>`,
      '</svg>',
    ].join('');
  };

  const round = (value: number) => Math.round(value * 100) / 100;
  // From the palette, not typed out again here: a tab icon that keeps its old colours after somebody
  // edits the one file they were told to edit is the drift this plugin exists to prevent.
  const { appBg: ground, accent } = appPalette.tokens.dark;

  return {
    name: 'instadarts-favicon',
    configureServer(server) {
      server.middlewares.use('/favicon.svg', (_req, res) => {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.end(render());
      });
    },
    closeBundle() {
      // Vite runs `closeBundle` when the dev server shuts down as well as after a build, so on a
      // checkout that has only ever run `npm run dev` there is no `dist/client` to write into.
      // Today the neighbouring wasm copy happens to create it first; that is not something to rely on.
      const out = fileURLToPath(new URL('./dist/client/', import.meta.url));
      mkdirSync(out, { recursive: true });
      writeFileSync(`${out}favicon.svg`, render());
    },
  };
}

function quietWsProxyErrors(): Plugin {
  return {
    name: 'quiet-ws-proxy-errors',
    configureServer(server) {
      const log = server.config.logger;
      const orig = log.error.bind(log);
      log.error = (msg: string, options?: { timestamp?: boolean; error?: Error }) => {
        if (msg.includes('ws proxy error') || msg.includes('ws proxy socket error')) return;
        return orig(msg, options);
      };
    },
  };
}

/**
 * The application's version, from the one place it is declared.
 *
 * Substituted into the client below rather than fetched from the server: a release *is* the source,
 * so the bundle and the server it talks to are built from the same snapshot and a round trip could
 * not tell the page anything the build does not already know.
 */
const APP_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
).version as string;

/** Kept in step with the server's own PORT, so a second instance can be brought up beside a first. */
const SERVER_PORT = Number(process.env.PORT ?? 3000);
const CLIENT_PORT = Number(process.env.VITE_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), litertWasm(), favicon(), quietWsProxyErrors()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
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
