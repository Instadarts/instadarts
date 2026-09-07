import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import '../helpers';
import { handleClientLeave, handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { allClients, getClient } from '../../src/server/connections';
import { deleteLobby, deleteMatch, getAllLobbies, getAllMatches, getLobby, getMatch } from '../../src/server/store';
import { heldSeat, holdsSeat } from '../../src/server/seats';
import { releaseRateLimit } from '../../src/server/rateLimit';
import type { ServerMessage } from '../../src/shared/protocol';

vi.mock('../../src/server/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/config')>();
  return { ...actual, CONFIG: { ...actual.CONFIG, server: {
    ...actual.CONFIG.server, maxMatches: 2, maxPlayersPerMatch: 2,
  } } };
});

let nextSession = 0;
function connect() {
  const sessionId = `transition-${++nextSession}`;
  const received: ServerMessage[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (raw: string) => received.push(JSON.parse(raw)) } as unknown as WebSocket;
  registerClient(ws, { sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null });
  return {
    ws, sessionId, received,
    send(message: object) {
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(message));
    },
    last<T extends ServerMessage['type']>(type: T) {
      return received.filter((m) => m.type === type).at(-1) as Extract<ServerMessage, { type: T }> | undefined;
    },
  };
}

function lobby() {
  const host = connect();
  host.send({ type: 'create_lobby', acceptsJoins: true });
  return { host, lobby: getLobby(host.last('lobby_state')!.lobby.id)! };
}

function onlineMatch() {
  const { host, lobby: room } = lobby();
  host.send({ type: 'add_local_player', playerName: 'Alice' });
  const guest = connect();
  guest.send({ type: 'join_lobby', inviteCode: room.inviteCode });
  guest.send({ type: 'add_local_player', playerName: 'Bob' });
  host.send({ type: 'start_match' });
  return { host, guest, match: getMatch(host.last('match_started')!.match.id)! };
}

afterEach(() => {
  for (const [ws] of allClients()) removeClient(ws);
  for (const id of getAllLobbies().keys()) deleteLobby(id);
  for (const id of getAllMatches().keys()) deleteMatch(id);
});

describe('room transitions', () => {
  it('treats repeated create requests as the same lobby, seat and roster even at capacity', () => {
    const { host, lobby: room } = lobby();
    host.send({ type: 'add_local_player', playerName: 'Alice' });
    const seat = heldSeat(room.id, host.sessionId);
    lobby(); // Fill the room budget after the first create succeeded.
    for (let i = 0; i < 5; i++) host.send({ type: 'create_lobby', acceptsJoins: true });
    expect(host.last('error')).toBeUndefined();
    expect(host.last('lobby_state')!.lobby.id).toBe(room.id);
    expect(heldSeat(room.id, host.sessionId)).toEqual(seat);
    expect(room.players.map((p) => p.name)).toEqual(['Alice']);
    expect(getAllLobbies().size).toBe(2);
  });

  it('replaces an owned lobby without requiring a spare room when its join policy changes', () => {
    const { host, lobby: room } = lobby();
    const watcher = connect();
    watcher.send({ type: 'spectate', id: room.id });
    lobby();
    host.send({ type: 'create_lobby', acceptsJoins: false });
    expect(host.last('error')).toBeUndefined();
    expect(getLobby(room.id)).toBeUndefined();
    expect(host.last('lobby_state')!.lobby.acceptsJoins).toBe(false);
    expect(watcher.last('lobby_abandoned')).toBeDefined();
    expect(getClient(watcher.ws)).toMatchObject({ lobbyId: null, matchId: null, isSpectator: false });
    expect(getAllLobbies().size).toBe(2);
  });

  it.each(['create', 'join', 'spectate_lobby', 'spectate_match', 'reconnect_lobby', 'reconnect_match'])(
    'concedes and revokes the previous match seat before %s', (action) => {
      const { host, guest, match } = onlineMatch();
      const target = lobby();
      const targetIsMatch = action.endsWith('_match');
      if (targetIsMatch) {
        target.host.send({ type: 'add_local_player', playerName: 'Carol' });
        target.host.send({ type: 'start_match' });
      }
      const targetId = targetIsMatch ? target.host.last('match_started')!.match.id : target.lobby.id;
      const token = target.host.last('resume')!.token;
      if (action === 'create') {
        deleteLobby(targetId); // Creating from a match retains its summary and needs another slot.
        host.send({ type: 'create_lobby' });
      } else if (action === 'join') host.send({ type: 'join_lobby', inviteCode: target.lobby.inviteCode });
      else if (action.startsWith('spectate')) host.send({ type: 'spectate', id: targetId });
      else host.send({ type: 'reconnect', ...(targetIsMatch ? { matchId: targetId } : { lobbyId: targetId }), token });

      expect(host.last('error')).toBeUndefined();
      expect(match.departed).toEqual([match.players[0].id]);
      expect(match.rematchVotes[match.players[0].id]).toBe('declined');
      expect(match.winnerId).toBe(match.players[1].id);
      expect(guest.last('match_finished')).toBeDefined();
      expect(holdsSeat(match.id, host.sessionId)).toBe(false);
      const destination = action === 'create' ? host.last('lobby_state')!.lobby.id : targetId;
      expect(getClient(host.ws)).toMatchObject({
        lobbyId: targetIsMatch ? null : destination,
        matchId: targetIsMatch ? destination : null,
        isSpectator: action.startsWith('spectate'),
      });
    },
  );

  it('concedes before watching its own match, and disconnecting cannot orphan that seat', () => {
    const { host, match } = onlineMatch();
    host.send({ type: 'spectate', id: match.id });
    expect(match.departed).toEqual([match.players[0].id]);
    expect(holdsSeat(match.id, host.sessionId)).toBe(false);
    expect(host.last('match_state')!.youAreSpectator).toBe(true);
    handleClientLeave(host.ws);
    expect(getClient(host.ws)).toMatchObject({ lobbyId: null, matchId: null, isSpectator: false });
    expect(match.status).toBe('finished');
  });

  it('abandons its hosted lobby when giving up the host seat to spectate it', () => {
    const { host, lobby: room } = lobby();
    host.send({ type: 'spectate', id: room.id });
    expect(getLobby(room.id)).toBeUndefined();
    expect(host.last('lobby_abandoned')).toBeDefined();
    expect(getClient(host.ws)).toMatchObject({ lobbyId: null, matchId: null, isSpectator: false });
  });

  it('removes a guest roster and seat before joining another lobby', () => {
    const source = lobby();
    const guest = connect();
    guest.send({ type: 'join_lobby', inviteCode: source.lobby.inviteCode });
    guest.send({ type: 'add_local_player', playerName: 'Bob' });
    const target = lobby();
    guest.send({ type: 'join_lobby', inviteCode: target.lobby.inviteCode });
    expect(source.lobby.players).toEqual([]);
    expect(holdsSeat(source.lobby.id, guest.sessionId)).toBe(false);
    expect(holdsSeat(target.lobby.id, guest.sessionId)).toBe(true);
  });

  it.each(['create', 'join', 'spectate', 'reconnect'])(
    'clears the previous match and role when a spectator enters a lobby through %s', (action) => {
      const { match } = onlineMatch();
      const watcher = connect();
      watcher.send({ type: 'spectate', id: match.id });
      const target = lobby();
      if (action === 'create') {
        deleteLobby(target.lobby.id);
        watcher.send({ type: 'create_lobby' });
      } else if (action === 'join') watcher.send({ type: 'join_lobby', inviteCode: target.lobby.inviteCode });
      else if (action === 'spectate') watcher.send({ type: 'spectate', id: target.lobby.id });
      else watcher.send({ type: 'reconnect', lobbyId: target.lobby.id, token: target.host.last('resume')!.token });
      expect(watcher.last('error')).toBeUndefined();
      expect(getClient(watcher.ws)).toMatchObject({
        lobbyId: watcher.last('lobby_state')!.lobby.id, matchId: null, isSpectator: action === 'spectate',
      });
      expect(match.departed).toEqual([]);
    },
  );

  it('allows an existing guest to repeat join at the user cap without changing its seat', () => {
    const { lobby: room } = lobby();
    const guest = connect();
    guest.send({ type: 'join_lobby', inviteCode: room.inviteCode });
    const seat = heldSeat(room.id, guest.sessionId);
    guest.send({ type: 'join_lobby', inviteCode: room.inviteCode });
    expect(guest.last('error')).toBeUndefined();
    expect(heldSeat(room.id, guest.sessionId)).toEqual(seat);
  });

  it('preserves the current seat when a destination or its credential is invalid or full', () => {
    const { host, match } = onlineMatch();
    const target = onlineMatch();
    const before = { ...getClient(host.ws) };
    const seat = heldSeat(match.id, host.sessionId);
    for (const request of [
      { type: 'create_lobby' },
      { type: 'join_lobby', inviteCode: 'invalid' },
      { type: 'spectate', id: 'missing' },
      { type: 'reconnect', matchId: target.match.id, token: 'invalid' },
      // A real match token presented as a lobby must not steal the seat before discovering the mismatch.
      { type: 'reconnect', lobbyId: target.match.id, token: target.host.last('resume')!.token },
      { type: 'reconnect', lobbyId: target.match.id, matchId: target.match.id, token: target.host.last('resume')!.token },
    ]) {
      host.send(request);
      expect(getClient(host.ws)).toEqual(before);
      expect(heldSeat(match.id, host.sessionId)).toEqual(seat);
      expect(match.departed).toEqual([]);
      expect(holdsSeat(target.match.id, target.host.sessionId)).toBe(true);
    }
  });

  it('preserves a match seat when the destination lobby is full', () => {
    const { host, match } = onlineMatch();
    const target = lobby();
    connect().send({ type: 'join_lobby', inviteCode: target.lobby.inviteCode });
    const seat = heldSeat(match.id, host.sessionId);
    host.send({ type: 'join_lobby', inviteCode: target.lobby.inviteCode });
    expect(host.last('error')?.message).toBe('Lobby is full');
    expect(heldSeat(match.id, host.sessionId)).toEqual(seat);
    expect(match.departed).toEqual([]);
  });

  it('requires leaving before taking a different seat in the same room, but accepts its own token again', () => {
    const { host, guest, match } = onlineMatch();
    const hostSeat = heldSeat(match.id, host.sessionId);
    const guestSeat = heldSeat(match.id, guest.sessionId);
    host.send({ type: 'reconnect', matchId: match.id, token: guestSeat!.token });
    expect(host.last('error')).toBeDefined();
    expect(heldSeat(match.id, host.sessionId)).toEqual(hostSeat);
    expect(heldSeat(match.id, guest.sessionId)).toEqual(guestSeat);
    host.received.length = 0;
    host.send({ type: 'reconnect', matchId: match.id, token: hostSeat!.token });
    expect(host.last('error')).toBeUndefined();
    expect(host.last('match_state')!.yourPlayerIds).toEqual(hostSeat!.seat.playerIds);
    expect(match.departed).toEqual([]);
  });
});
