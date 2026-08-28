import type { Server } from 'node:http';
import type { ClientRequestHandler } from './staticServing';
import { DEV_CLIENT } from './env';

/**
 * The client, built on demand, served from this process.
 *
 * `staticServing.ts` is the built client — bytes decided before the server started. This is the
 * other one: Vite, mounted as middleware, transforming source per request and hot-reloading it.
 * Development is the only run that has it, and one server answering for both the app and the
 * WebSocket is what lets a scoring device on the LAN reach the whole thing through a single port.
 */

/**
 * Mount Vite on `server`, or return `null` for a run that did not ask for it.
 *
 * The import is dynamic and reached only through `DEV_CLIENT`, which is what keeps Vite out of
 * production: the specifier is never evaluated, so Node never resolves it, and the runtime
 * dependencies stay `ws` and `tsx`. `scripts/build-mjs.sh` marks it external for the same reason —
 * a bundler follows a dynamic import that a running program never will.
 */
export async function createDevClient(server: Server): Promise<ClientRequestHandler | null> {
  if (!DEV_CLIENT) return null;

  const { createServer } = await import('vite');
  const vite = await createServer({
    server: {
      middlewareMode: true,
      // `ws.server` and not `middlewareMode.server`: the latter only wires the proxy middleware,
      // which this config no longer has. Without this, Vite decides its hot-reload socket has
      // nowhere to live and opens a second listener on port 24678 — the two ports this change
      // exists to get rid of, back under a different number. Naming the server also tells the
      // browser-side client to connect to the page's own origin, which is what makes hot reload
      // work on the phone rather than only on this machine.
      ws: { server },
    },
  });

  // The same shape the built client answers in, so a run has one client rather than two kinds.
  // Always `true`: Vite's stack ends in a 404 of its own making, so it answers everything it is
  // given and there is never anything behind it to fall through to.
  return async (req, res) => {
    vite.middlewares(req, res);
    return true;
  };
}
