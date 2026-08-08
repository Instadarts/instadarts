import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { startHeartbeat, HEARTBEAT_MS } from '../../src/server/heartbeat';

/**
 * Cutting the connections that vanished without saying so.
 *
 * Run against a real `ws` server rather than a stub, because the whole mechanism is the protocol's
 * own ping and pong: a fake socket would answer however we told it to, which would test nothing. The
 * interval is passed in so a test takes milliseconds rather than a minute.
 */

const TICK = 40;

const running: { wss: WebSocketServer; stop: () => void; clients: WebSocket[] }[] = [];

async function serve(intervalMs = TICK) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const stop = startHeartbeat(wss, intervalMs);
  const entry = { wss, stop, clients: [] as WebSocket[] };
  running.push(entry);

  const port = (wss.address() as { port: number }).port;
  return {
    wss,
    async connect({ answers = true } = {}) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      entry.clients.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      // A phone whose radio drops does not *refuse* to answer — nothing at its end reads the ping at
      // all. Pausing the socket is that: bytes arrive, no frame is ever parsed, and the automatic
      // pong `ws` would otherwise send is never reached. Merely listening for 'ping' would not do
      // it; the reply happens below any listener.
      if (!answers) ws.pause();
      return ws;
    },
  };
}

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const { wss, stop, clients } of running.splice(0)) {
    stop();
    for (const ws of clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

describe('the heartbeat', () => {
  it('leaves a connection that answers alone', async () => {
    const server = await serve();
    const ws = await server.connect();

    await settle(TICK * 5);

    expect(server.wss.clients.size).toBe(1);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('cuts one that stops answering', async () => {
    // The two hours this saves: without it the socket, its client record and its device claim sit
    // there until TCP keepalive gives up.
    const server = await serve();
    await server.connect({ answers: false });
    expect(server.wss.clients.size).toBe(1);

    await settle(TICK * 4);

    // Asserted on the server, which is the side that had the resource. The client cannot be asked:
    // a socket paused hard enough to miss a ping is paused hard enough to miss the close as well,
    // which is exactly the situation being tested.
    expect(server.wss.clients.size).toBe(0);
  });

  it('cuts it through an ordinary close, so everything that happens on a disconnect still happens', async () => {
    // `terminate()` fires the socket's own 'close', which is what releases the claim and the client
    // record. If this stopped being true, devices would leak while their sockets did not.
    const server = await serve();
    let closedOnServer = false;
    server.wss.once('connection', (socket) => socket.once('close', () => { closedOnServer = true; }));

    await server.connect({ answers: false });
    await settle(TICK * 4);

    expect(closedOnServer).toBe(true);
  });

  it('gives a silent connection two rounds before cutting it', async () => {
    // One to be pinged, one to answer. Cutting on the first would kill a connection that had simply
    // not been asked yet.
    const server = await serve(200);
    await server.connect({ answers: false });

    await settle(250);
    expect(server.wss.clients.size).toBe(1);

    await settle(250);
    expect(server.wss.clients.size).toBe(0);
  });

  it('stops when told to, and cuts nothing afterwards', async () => {
    const server = await serve();
    const ws = await server.connect({ answers: false });

    running.find((r) => r.wss === server.wss)!.stop();
    await settle(TICK * 5);

    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('watches connections that arrive after it started', async () => {
    const server = await serve();
    await settle(TICK * 2);
    await server.connect({ answers: false });

    await settle(TICK * 4);

    expect(server.wss.clients.size).toBe(0);
  });

  it('ships with a period that is a backstop, not a poll', async () => {
    // Long enough to cost nothing on a big server; short enough that a dead phone frees its slot in
    // a minute or two rather than in hours.
    expect(HEARTBEAT_MS).toBeGreaterThanOrEqual(10_000);
    expect(HEARTBEAT_MS).toBeLessThanOrEqual(60_000);
  });
});
