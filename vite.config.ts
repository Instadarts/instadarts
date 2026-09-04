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

/**
 * Cross-origin isolation → SharedArrayBuffer → LiteRT's threaded WASM build.
 *
 * The same three `staticServing.ts` puts on every production response, because development is now
 * the same shape: one origin serving the page, its assets and its socket. They were two headers
 * here for as long as the dev client had a port and an origin of its own; keeping them two after
 * that stopped being true would only mean development and production disagreeing about what a
 * client response looks like, in the direction that hides a mistake until release.
 */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
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
        // with ERR_BLOCKED_BY_RESPONSE and model loading hangs forever with no error. This route is
        // Vite middleware and answers before `server.headers` would, so it sets them itself.
        for (const [header, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(header, value);
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      cpSync(wasmDir, fileURLToPath(new URL('./dist/client/wasm/', import.meta.url)), { recursive: true });
    },
  };
}

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
        // Middleware, like the wasm route above, so `server.headers` never sees this response and
        // it has to carry the isolation headers itself. Production serves the built favicon through
        // the same rules as everything else and gives it all three; a tab icon does not need them,
        // but a response that differs between the two servers for no reason is the thing worth not
        // having.
        for (const [header, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(header, value);
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

export default defineConfig({
  plugins: [react(), litertWasm(), favicon()],
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
  // No port, host or proxy: this server is not started on its own. `src/server/devClient.ts`
  // mounts it as middleware inside the API server, which owns the port and answers `/ws` itself.
  server: {
    // Without these the app still runs, but LiteRT silently falls back to single-threaded WASM —
    // it only opts into threads when crossOriginIsolated is true. Nothing here is cross-origin, so
    // applying them to every document costs nothing.
    headers: ISOLATION_HEADERS,
  },
});
