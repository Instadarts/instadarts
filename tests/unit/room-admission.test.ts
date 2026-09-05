import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ServerMessage } from '../../src/shared/protocol';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { getClient } from '../../src/server/connections';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { MAX_ROOMS, roomCount } from '../../src/server/capacity';
import { deleteLobby, deleteMatch, getAllLobbies, getAllMatches, getLobby, getMatch } from '../../src/server/store';
import { holdsSeat } from '../../src/server/seats';
import '../helpers';

// A small deployment exercises the real capacity checks without filling the default 10,000 rooms.
vi.mock('../../src/server/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/config')>();
  return { ...actual, CONFIG: { ...actual.CONFIG, server: { ...actual.CONFIG.server, maxMatches: 2 } } };
});

let nextSession = 0;
const sockets: WebSocket[] = [];

function connect() {
  const sessionId = `admission-${++nextSession}`;
  const received: ServerMessage[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;
  registerClient(ws, { sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null });
  sockets.push(ws);
  return {
    ws, sessionId,
    send(message: object) {
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(message));
    },
    last<T extends ServerMessage['type']>(type: T) {
      return received.filter((message) => message.type === type).at(-1) as
        Extract<ServerMessage, { type: T }> | undefined;
    },
  };
}

function readyLobby() {
  const host = connect();
  host.send({ type: 'create_lobby' });
  host.send({ type: 'add_local_player', playerName: 'Alice' });
  const lobby = host.last('lobby_state')!.lobby;
  return { host, lobby };
}

afterEach(() => {
  for (const ws of sockets.splice(0)) removeClient(ws);
  for (const id of getAllLobbies().keys()) deleteLobby(id);
  for (const id of getAllMatches().keys()) deleteMatch(id);
});

describe('room admission through gameplay handlers', () => {
  it('starts an existing lobby when lobbies fill the budget', () => {
    const { host, lobby } = readyLobby();
    readyLobby();
    expect(roomCount()).toBe(MAX_ROOMS);

    host.send({ type: 'start_match' });

    expect(host.last('error')).toBeUndefined();
    const match = host.last('match_started')!.match;
    expect(getLobby(lobby.id)).toBeUndefined();
    expect(getMatch(match.id)?.players).toHaveLength(1);
    expect(holdsSeat(match.id, host.sessionId)).toBe(true);
    expect(roomCount()).toBe(MAX_ROOMS);
  });

  it('starts an existing lobby when lobbies and matches fill the budget', () => {
    readyLobby().host.send({ type: 'start_match' });
    const { host, lobby } = readyLobby();
    expect(getAllMatches().size).toBe(1);
    expect(roomCount()).toBe(MAX_ROOMS);

    host.send({ type: 'start_match' });

    expect(host.last('error')).toBeUndefined();
    expect(host.last('match_started')).toBeDefined();
    expect(getLobby(lobby.id)).toBeUndefined();
    expect(getAllMatches().size).toBe(2);
    expect(roomCount()).toBe(MAX_ROOMS);
  });

  it('still refuses a new lobby at the budget', () => {
    readyLobby();
    readyLobby();
    const newcomer = connect();

    newcomer.send({ type: 'create_lobby' });

    expect(newcomer.last('error')?.message).toBe('Server is full, try again later');
    expect(newcomer.last('lobby_state')).toBeUndefined();
    expect(getClient(newcomer.ws)?.lobbyId).toBeNull();
    expect(roomCount()).toBe(MAX_ROOMS);
  });

  it('requires another slot for a rematch and retains the summary when one is available', () => {
    const { host } = readyLobby();
    host.send({ type: 'update_settings', settings: {
      mode: 'x01', modeSettings: { startScore: 180, doubleIn: false, doubleOut: false },
    } });
    host.send({ type: 'start_match' });
    for (let i = 0; i < 3; i++) host.send({ type: 'add_dart', dart: { x: 500_000, y: 726_000 } });
    host.send({ type: 'submit_visit' });
    expect(host.last('error')).toBeUndefined();
    const summary = host.last('match_state')!.match;
    expect(summary.status).toBe('finished');
    const { lobby: otherLobby } = readyLobby();
    expect(roomCount()).toBe(MAX_ROOMS);

    host.send({ type: 'rematch_vote', playerId: summary.players[0].id, answer: 'accepted' });

    expect(host.last('error')?.message).toBe('Server is full, try again later');
    expect(host.last('match_started')!.match.id).toBe(summary.id);
    expect(getClient(host.ws)?.matchId).toBe(summary.id);
    expect(roomCount()).toBe(MAX_ROOMS);

    deleteLobby(otherLobby.id);
    host.send({ type: 'rematch_vote', playerId: summary.players[0].id, answer: 'accepted' });

    const rematch = host.last('match_started')!.match;
    expect(rematch.id).not.toBe(summary.id);
    expect(rematch.status).toBe('in_progress');
    expect(getMatch(summary.id)?.expiresAt).toBe(summary.expiresAt);
    expect(getMatch(summary.id)?.status).toBe('finished');
    expect(getClient(host.ws)?.matchId).toBe(rematch.id);
    expect(holdsSeat(rematch.id, host.sessionId)).toBe(true);
    expect(host.last('resume')?.matchId).toBe(rematch.id);
    expect(roomCount()).toBe(MAX_ROOMS);
  });
});
