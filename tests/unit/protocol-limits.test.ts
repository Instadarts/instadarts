import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import '../helpers';
import * as protocol from '../../src/shared/protocol';
import { allClients, broadcastToMatch, send } from '../../src/server/connections';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';

let nextSession = 0;
function connect(deviceId: string | null = null) {
  const received: protocol.ServerMessage[] = [];
  const socket = {
    readyState: 1, OPEN: 1, bufferedAmount: 0,
    send: vi.fn((raw: string) => received.push(JSON.parse(raw))),
    close: vi.fn((_code: number, _reason: string) => { socket.readyState = 2; }),
    terminate: vi.fn(() => { socket.readyState = 2; }),
  };
  const ws = socket as unknown as WebSocket;
  registerClient(ws, {
    sessionId: `limits-${++nextSession}`, lobbyId: null, matchId: 'room', isSpectator: false, deviceId,
  });
  received.length = 0;
  socket.send.mockClear();
  return { ws, socket, received };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const [ws] of allClients()) removeClient(ws);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('malformed protocol input', () => {
  it.each(['{', '{}', '{"type":null}', 'null'])(
    'bounds a 1,000-message malformed burst (%s) and ignores queued messages after closing', (raw) => {
      const { ws, socket, received } = connect();
      const parse = vi.spyOn(protocol, 'parseMessage');
      for (let i = 0; i < 1_000; i++) handleMessage(ws, raw);
      expect(socket.close).toHaveBeenCalledExactlyOnceWith(1013, 'Rate limit exceeded');
      expect(received).toHaveLength(60);
      expect(received.every((m) => m.type === 'error' && m.message === 'Invalid message format')).toBe(true);
      expect(parse).toHaveBeenCalledTimes(61);

      const healthy = connect();
      handleMessage(healthy.ws, '{');
      expect(healthy.socket.close).not.toHaveBeenCalled();
      expect(healthy.received).toEqual([{ type: 'error', message: 'Invalid message format' }]);
    },
  );

  it.each(['{', '{"type":"start_match"}'])('shares the general budget with valid commands, overflowing on %s', (last) => {
    const { ws, socket } = connect();
    for (let i = 0; i < 30; i++) {
      handleMessage(ws, '{"type":"start_match"}');
      handleMessage(ws, '{');
    }
    expect(socket.close).not.toHaveBeenCalled();
    handleMessage(ws, last);
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(1013, 'Rate limit exceeded');
  });

  it('refills the general budget for occasional malformed input', () => {
    const { ws, socket, received } = connect();
    for (let i = 0; i < 60; i++) handleMessage(ws, '{');
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 10; i++) handleMessage(ws, '{');
    expect(socket.close).not.toHaveBeenCalled();
    expect(received).toHaveLength(70);
    handleMessage(ws, '{');
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('preserves separate media/tip budgets while also limiting malformed scoring-device input', () => {
    const { ws, socket, received } = connect('camera');
    for (let i = 0; i < 60; i++) handleMessage(ws, '{"type":"media_ready"}');
    for (let i = 0; i < 90; i++) handleMessage(ws, '{"type":"scorer_tips","tips":[]}');
    expect(socket.close).not.toHaveBeenCalled();
    received.length = 0;
    for (let i = 0; i < 60; i++) handleMessage(ws, '{');
    expect(socket.close).not.toHaveBeenCalled();
    expect(received).toHaveLength(60);
    handleMessage(ws, '{');
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(1013, 'Rate limit exceeded');
  });
});

describe('outgoing WebSocket backlog', () => {
  const limit = 4 * 1024 * 1024;
  const message: protocol.ServerMessage = { type: 'error', message: 'é' };
  const bytes = Buffer.byteLength(JSON.stringify(message));

  it('allows a send that fits exactly at the byte threshold', () => {
    const { ws, socket, received } = connect();
    socket.bufferedAmount = limit - bytes;
    send(ws, message);
    expect(received).toEqual([message]);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it('terminates before enqueueing a message that would cross the threshold, counting UTF-8 bytes', () => {
    const { ws, socket } = connect();
    socket.bufferedAmount = limit - bytes + 1;
    send(ws, message);
    send(ws, message);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('does not serialize another snapshot for an already overfull socket', () => {
    const { ws, socket } = connect();
    socket.bufferedAmount = limit + 1;
    const serialize = vi.spyOn(protocol, 'formatMessage');
    send(ws, message);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(serialize).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('rejects a single snapshot larger than the threshold even with an empty queue', () => {
    const { ws, socket } = connect();
    send(ws, { type: 'error', message: 'x'.repeat(limit) });
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('continues a broadcast to healthy recipients after terminating a slow one', () => {
    const slow = connect();
    const healthy = connect();
    slow.socket.bufferedAmount = limit;
    broadcastToMatch('room', message);
    expect(slow.socket.terminate).toHaveBeenCalledOnce();
    expect(slow.received).toEqual([]);
    expect(healthy.received).toEqual([message]);
    expect(healthy.socket.terminate).not.toHaveBeenCalled();
  });
});
