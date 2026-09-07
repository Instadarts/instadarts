import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import '../helpers';
import { handleClientLeave, handleMessage, registerClient, removeClient, scheduleDisconnect } from '../../src/server/wsHandler';
import { allClients, clientCount, getClient } from '../../src/server/connections';
import { deleteLobby, deleteMatch, getAllLobbies, getAllMatches, getLobby, getMatch } from '../../src/server/store';
import { heldSeat } from '../../src/server/seats';
import { createPairingCode, redeemPairingCode, resetDeviceRegistry } from '../../src/server/devices';
import { releaseRateLimit } from '../../src/server/rateLimit';
import type { ServerMessage } from '../../src/shared/protocol';

let sessionCounter = 0;

function connect() {
  const sessionId = `disconnect-${++sessionCounter}`;
  const received: ServerMessage[] = [];
  const ws = {
    readyState: 1, OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;
  registerClient(ws, { sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null });
  return {
    ws, sessionId,
    send(message: object) {
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(message));
    },
    last<T extends ServerMessage['type']>(type: T) {
      return received.filter((m) => m.type === type).at(-1) as Extract<ServerMessage, { type: T }>;
    },
    close() {
      Object.defineProperty(ws, 'readyState', { value: 3 });
      // The same deferred leave and connection cleanup used by index.ts's close listener.
      scheduleDisconnect(ws, () => { handleClientLeave(ws); removeClient(ws); });
    },
  };
}

function lobby() {
  const host = connect();
  host.send({ type: 'create_lobby', acceptsJoins: true });
  const state = host.last('lobby_state').lobby;
  return { host, lobbyId: state.id, inviteCode: state.inviteCode };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runOnlyPendingTimers();
  for (const [ws] of allClients()) removeClient(ws);
  for (const id of getAllLobbies().keys()) deleteLobby(id);
  for (const id of getAllMatches().keys()) deleteMatch(id);
  resetDeviceRegistry();
  vi.useRealTimers();
});

describe('disconnect grace and connection cleanup', () => {
  it.each(['lobby', 'match'] as const)('reclaims a closed %s connection after its seat is resumed', (phase) => {
    const { host, lobbyId } = lobby();
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
    if (phase === 'match') host.send({ type: 'start_match', lobbyId });
    const room = phase === 'lobby' ? { lobbyId } : { matchId: host.last('match_started').match.id };
    const roomId = room.lobbyId ?? room.matchId!;
    const originalSeat = heldSeat(roomId, host.sessionId)!;
    const { code } = createPairingCode(host.sessionId);
    host.close();

    const returning = connect();
    returning.send({ type: 'reconnect', ...room, token: originalSeat.token });
    expect(returning.last('error')).toBeUndefined();
    expect(heldSeat(roomId, returning.sessionId)?.seat).toEqual(originalSeat.seat);

    vi.advanceTimersByTime(3_200);
    expect(getClient(host.ws)).toBeUndefined();
    expect(clientCount()).toBe(1);
    expect(redeemPairingCode(code, 'late-device')).toBeNull();
    expect(heldSeat(roomId, returning.sessionId)?.seat).toEqual(originalSeat.seat);
    if (phase === 'lobby') expect(getLobby(roomId)?.hostSessionId).toBe(returning.sessionId);
    else {
      expect(getMatch(roomId)?.status).toBe('in_progress');
      expect(getMatch(roomId)?.departed).toEqual([]);
    }
  });

  it('reclaims every replaced socket across successive reloads', () => {
    const { host, lobbyId } = lobby();
    const token = host.last('resume').token;
    let current = host;
    const closed: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      current.close();
      closed.push(current.ws);
      vi.advanceTimersByTime(500);
      current = connect();
      current.send({ type: 'reconnect', lobbyId, token });
    }
    vi.advanceTimersByTime(3_000);
    expect(closed.map((ws) => getClient(ws))).toEqual([undefined, undefined, undefined]);
    expect(clientCount()).toBe(1);
    expect(getLobby(lobbyId)?.hostSessionId).toBe(current.sessionId);
  });

  it.each(['host', 'guest'] as const)('keeps empty seats independent when only the %s returns', (who) => {
    const { host, lobbyId, inviteCode } = lobby();
    const guest = connect();
    guest.send({ type: 'join_lobby', inviteCode });
    const token = (who === 'host' ? host : guest).last('resume').token;
    host.close();
    guest.close();

    const returning = connect();
    returning.send({ type: 'reconnect', lobbyId, token });
    vi.advanceTimersByTime(3_200);
    expect(getClient(host.ws)).toBeUndefined();
    expect(getClient(guest.ws)).toBeUndefined();
    expect(clientCount()).toBe(1);
    if (who === 'host') {
      expect(getLobby(lobbyId)?.hostSessionId).toBe(returning.sessionId);
      expect(heldSeat(lobbyId, guest.sessionId)).toBeNull();
    } else {
      expect(getLobby(lobbyId)).toBeUndefined();
      expect(returning.last('lobby_abandoned')).toEqual({ type: 'lobby_abandoned' });
    }
  });

  it('preserves the grace period and concedes an unresumed match seat at its deadline', () => {
    const { host, lobbyId } = lobby();
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
    host.send({ type: 'start_match', lobbyId });
    const match = getMatch(host.last('match_started').match.id)!;
    host.close();
    vi.advanceTimersByTime(2_999);
    expect(match.status).toBe('in_progress');
    expect(match.departed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(match.status).toBe('finished');
    expect(match.departed).toEqual(match.players.map((p) => p.id));
    expect(clientCount()).toBe(0);
  });

  it('keeps a replaced open socket registered until it actually closes', () => {
    const { host, lobbyId } = lobby();
    const returning = connect();
    returning.send({ type: 'reconnect', lobbyId, token: host.last('resume').token });
    vi.advanceTimersByTime(3_200);
    expect(host.last('seat_taken_over')).toEqual({ type: 'seat_taken_over' });
    expect(getClient(host.ws)?.lobbyId).toBeNull();
    expect(clientCount()).toBe(2);
    host.close();
    expect(clientCount()).toBe(1);
    expect(getLobby(lobbyId)?.hostSessionId).toBe(returning.sessionId);
  });
});
