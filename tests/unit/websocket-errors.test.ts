import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { ServerMessage } from '../../src/shared/protocol';

// Run the production entry point in a child: an unhandled transport or handler error must fail a test, not
// terminate the test runner. No browser or built frontend is needed for these wire regressions.
const root = fileURLToPath(new URL('../..', import.meta.url));
let child: ChildProcess;
let directory: string;
let output: string;
let url: string;
const sockets: (WebSocket | Socket)[] = [];

beforeEach(async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close((err) => err ? reject(err) : resolve()));

  directory = await mkdtemp(join(tmpdir(), 'instadarts-ws-errors-'));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({
    server: { http: { enabled: true, port }, https: { enabled: false }, maxMatches: 1 },
    media: { enabled: false },
  }));
  output = '';
  url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', DEV_CLIENT: '0', QUIET: '1', INSTADARTS_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (data: Buffer) => { output = (output + data.toString()).slice(-16_000); };
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  await vi.waitFor(() => {
    expect(child.exitCode, output).toBeNull();
    expect(output).toContain('InstaDarts server listening on:');
  }, { timeout: 5000 });
}, 10_000);

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket instanceof WebSocket) socket.terminate();
    else socket.destroy();
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(force); }
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function connect(origin?: string) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', { origin });
  sockets.push(ws);
  const messages: ServerMessage[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  // A broken server may reset its clients while crashing. Observe closure without letting a
  // client-side error become an unhandled exception in the test runner too.
  ws.on('error', () => {});
  const closed = new Promise<number>((resolve) => ws.once('close', resolve));
  await once(ws, 'open');
  return {
    ws, closed,
    send(message: object) { ws.send(JSON.stringify(message)); },
    async message<T extends ServerMessage['type']>(type: T) {
      await vi.waitFor(() => {
        expect(child.exitCode, output).toBeNull();
        expect(messages.some((message) => message.type === type)).toBe(true);
      });
      return messages.filter((message) => message.type === type).at(-1) as Extract<ServerMessage, { type: T }>;
    },
  };
}

async function stats() {
  const response = await fetch(url + '/server-stats');
  expect(response.ok).toBe(true);
  expect(child.exitCode, output).toBeNull();
  return response.json();
}

describe('WebSocket error isolation', () => {
  it('refuses foreign and opaque browser origins before registering a client', async () => {
    for (const origin of ['https://unrelated.example', 'null']) {
      const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', { origin });
      sockets.push(ws);
      ws.on('error', () => {});
      const status = await new Promise<number>((resolve) => {
        ws.once('open', () => resolve(101));
        ws.once('unexpected-response', (_request, response) => {
          response.resume();
          ws.terminate();
          resolve(response.statusCode!);
        });
      });
      expect(status).toBe(403);
    }
    expect((await stats()).connectedClients).toBe(0);
    const browser = await connect(url);
    await browser.message('mode_catalog');
    expect((await stats()).connectedClients).toBe(1);
  });

  it('survives a JSON device claim that cannot be converted to a number', async () => {
    const client = await connect();
    client.send({ type: 'activate_devices', devices: [{
      deviceId: 'device-id-1234567', tokenHash: 'a'.repeat(64), grabbedAt: { toString: null },
    }] });
    expect((await client.message('devices_state')).devices).toEqual([]);
    client.send({ type: 'create_lobby' });
    expect((await client.message('lobby_state')).lobby.id).toBeTruthy();
    expect((await stats()).openLobbies).toBe(1);
  });

  it('accepts a valid message exactly at the 16 KiB limit', async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'create_lobby' }).padEnd(16 * 1024, ' '));
    expect((await client.message('lobby_state')).lobby.id).toBeTruthy();
    expect((await stats()).openLobbies).toBe(1);
  });

  it.each([
    { name: 'an oversized message', payload: 'x'.repeat(16 * 1024 + 1), mask: true, code: 1009 },
    { name: 'an unmasked frame', payload: '{}', mask: false, code: 1002 },
  ])('closes only the offending connection for $name', async ({ payload, mask, code }) => {
    const player = await connect();
    player.send({ type: 'create_lobby' });
    await player.message('lobby_state');
    player.send({ type: 'add_local_player', playerName: 'Alice' });
    player.send({ type: 'start_match' });
    const match = (await player.message('match_started')).match;

    const offender = await connect();
    offender.ws.send(payload, { mask });
    expect(await offender.closed).toBe(code);

    player.send({ type: 'add_dart', dart: { x: 500_000, y: 500_000 } });
    const state = (await player.message('match_state')).match;
    expect(state.id).toBe(match.id);
    expect(state.currentVisit?.darts).toHaveLength(1);
    expect((await stats()).runningMatches).toBe(1);
    // Cleanup must free the bad socket, and a new connection must still be admitted.
    const newcomer = await connect();
    await newcomer.message('mode_catalog');
    expect((await stats()).connectedClients).toBe(2);
  });

  it('handles an oversized frame even when the socket is being refused for capacity', async () => {
    const limit = (await stats()).capacity.maxConnections as number;
    for (let i = 0; i < limit; i++) {
      const client = await connect();
      await client.message('mode_catalog');
    }

    const address = new URL(url);
    const attacker = createConnection({ host: address.hostname, port: Number(address.port) });
    sockets.push(attacker);
    attacker.on('error', () => {});
    const closed = new Promise<void>((resolve) => attacker.once('close', () => resolve()));
    await once(attacker, 'connect');
    // Pipeline the upgrade and masked frame so the oversized payload is already waiting when
    // the connection callback refuses admission. A zero mask key leaves the payload unchanged.
    const request = `GET /ws HTTP/1.1\r\nHost: ${address.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    const header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(16 * 1024 + 1, 2);
    attacker.on('data', () => attacker.end());
    attacker.write(Buffer.concat([Buffer.from(request), header, Buffer.alloc(16 * 1024 + 1, 'x')]));
    await closed;

    await vi.waitFor(async () => {
      expect(child.exitCode, output).toBeNull();
      expect((await stats()).connectedClients).toBe(limit);
    });
    expect(output).not.toContain('Unhandled');
  });
});
