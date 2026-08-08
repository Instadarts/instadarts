// Finding the connections that are gone without having said so.
//
// A closed socket announces itself; a *vanished* one does not. A phone that loses its radio — driven
// out of range, battery dead, flight mode — sends no FIN, so the server keeps its socket, its client
// record and its device claim until TCP keepalive gives up, which on Linux is a little over two
// hours by default. For a scoring device that is two hours of a connection slot and a claim held by
// nobody.
//
// This is the backstop, not the main path: a device that powers itself down closes cleanly and the
// slot is free at once. What is left for this to catch is the ones that never got the chance.

import type { WebSocket, WebSocketServer } from 'ws';

/**
 * How long a silent connection has. Two of these pass before a socket is cut — one to be pinged,
 * one to answer — so the worst case is a little under twice this.
 */
export const HEARTBEAT_MS = 30_000;

/**
 * Ping every connection, and cut the ones that did not answer the last round.
 *
 * Returns the stopper. Terminating fires the socket's ordinary `close`, so everything that already
 * happens on a disconnect — the reload grace period, releasing the claim — happens here too, and
 * this file needs to know none of it.
 */
export function startHeartbeat(wss: WebSocketServer, intervalMs: number = HEARTBEAT_MS): () => void {
  // Weak, because the only thing that should keep a dead socket alive is the server's own client
  // set, and this must not be the reason one lingers.
  const answered = new WeakSet<WebSocket>();

  const watch = (ws: WebSocket) => {
    // Credited on arrival: a connection that has said nothing yet has also not failed to answer.
    answered.add(ws);
    ws.on('pong', () => answered.add(ws));
  };
  for (const ws of wss.clients) watch(ws);
  wss.on('connection', watch);

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!answered.has(ws)) {
        ws.terminate();
        continue;
      }
      answered.delete(ws);
      ws.ping();
    }
  }, intervalMs);

  // Never a reason for the process to stay up.
  timer.unref?.();

  return () => {
    clearInterval(timer);
    wss.off('connection', watch);
  };
}
