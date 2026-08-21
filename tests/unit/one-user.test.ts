// A match with one user holding every player — what the app calls a "Local Match".
//
// Written without naming a "local" flag anywhere, on purpose: there is no longer one to name.
// Everything here is a behaviour the old `isLocal` produced, and this file is what its collapse was
// measured against — every one of them survived it unchanged.
//
// The behaviours that already have a home elsewhere are not repeated here — leaving cancels the
// match (rematch.test.ts), the one user answers the re-match for everybody (rematch.test.ts), and a
// camera scores for whichever of its owner's players is up (vision-session.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import '../helpers';
import '../../src/server/modes/count-up';
import {
  handleClientLeave, handleMessage, registerClient, removeClient, scheduleDisconnect,
} from '../../src/server/wsHandler';
import { getLobby, getMatch } from '../../src/server/store';
import { heldSeat } from '../../src/server/seats';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { resetDeviceRegistry } from '../../src/server/devices';
import type { ServerMessage } from '../../src/shared/protocol';
import type { MatchState } from '../../src/shared/types';

/** Centre of the treble 20 bed. */
const T20 = { x: 500_000, y: 726_000 };

let sessionCounter = 0;
const openSockets: WebSocket[] = [];

function connect() {
  const sessionId = `one-user-${++sessionCounter}`;
  const received: (ServerMessage | { type: 'connected'; sessionId: string })[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;
  registerClient(ws, {
    sessionId, lobbyId: null, matchId: null, playerIds: [], isSpectator: false, deviceId: null,
  });
  openSockets.push(ws);

  return {
    ws, sessionId, received,
    send(message: object) {
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(message));
    },
    last<T extends ServerMessage['type']>(type: T) {
      return received.filter((m) => m.type === type).at(-1) as
        Extract<ServerMessage, { type: T }> | undefined;
    },
    resumeToken() { return this.last('resume')?.token; },
    spectator(): boolean | undefined {
      for (let i = received.length - 1; i >= 0; i--) {
        const m = received[i];
        if ((m.type === 'lobby_state' || m.type === 'match_state' || m.type === 'match_started')
          && m.youAreSpectator !== undefined) return m.youAreSpectator;
      }
      return undefined;
    },
  };
}

type Conn = ReturnType<typeof connect>;

/** A lobby held by one user, with the named players on it. */
function lobbyOf(names: string[]) {
  const user = connect();
  user.send({ type: 'create_lobby', acceptsJoins: false });
  const lobbyId = user.last('lobby_state')!.lobby.id;
  user.send({ type: 'update_settings', lobbyId, settings: { mode: 'count-up' } });
  for (const name of names) user.send({ type: 'add_local_player', lobbyId, playerName: name });
  return { user, lobbyId };
}

function startedOf(names: string[]) {
  const { user, lobbyId } = lobbyOf(names);
  user.send({ type: 'start_match', lobbyId });
  const match = user.last('match_started')!.match;
  return { user, matchId: match.id, players: match.players };
}

/** The match as this connection last saw it. */
function seen(user: Conn): MatchState {
  const latest = [...user.received].reverse().find((m) =>
    m.type === 'match_state' || m.type === 'match_started' || m.type === 'match_finished');
  return (latest as { match: MatchState }).match;
}

beforeEach(() => resetDeviceRegistry());
afterEach(() => {
  vi.useRealTimers();
  for (const ws of openSockets.splice(0)) removeClient(ws);
  resetDeviceRegistry();
});

describe('one user playing every player', () => {
  it('throws, undoes and submits for whichever player is up', () => {
    const { user, matchId, players } = startedOf(['Alice', 'Bob']);
    const [alice, bob] = players;

    user.send({ type: 'add_dart', matchId, dart: T20 });
    expect(seen(user).currentVisit?.playerId).toBe(alice.id);

    user.send({ type: 'undo_dart', matchId });
    expect(seen(user).currentVisit).toBeUndefined();

    for (let i = 0; i < 3; i++) user.send({ type: 'add_dart', matchId, dart: T20 });
    user.send({ type: 'submit_visit', matchId });

    // The board passed to Bob, and the same connection throws for him — the whole point of one user
    // holding several players.
    expect(seen(user).currentPlayerIndex).toBe(1);
    user.send({ type: 'add_dart', matchId, dart: T20 });
    expect(seen(user).currentVisit?.playerId).toBe(bob.id);
  });

  it('holds every player on its one seat, and is not a spectator', () => {
    // The seat is the durable answer to "which players are yours" and is unaffected by whether the
    // server also states it on the wire — which is exactly what the collapse changes.
    const { user, matchId, players } = startedOf(['Alice', 'Bob']);
    expect(heldSeat(matchId, user.sessionId)!.seat.playerIds).toEqual(players.map((p) => p.id));
    expect(user.spectator()).toBe(false);
  });
});

describe('one user running the lobby', () => {
  it('may start, reorder, rename and remove without anyone asking who it is', () => {
    const { user, lobbyId } = lobbyOf(['Alice', 'Bob', 'Carol']);
    const named = () => getLobby(lobbyId)!.players.map((p) => p.name);
    const idOf = (name: string) => getLobby(lobbyId)!.players.find((p) => p.name === name)!.id;

    user.send({ type: 'reorder_player', lobbyId, playerId: idOf('Carol'), direction: 'up' });
    expect(named()).toEqual(['Alice', 'Carol', 'Bob']);

    user.send({ type: 'set_player_name', lobbyId, playerId: idOf('Bob'), name: 'Robert' });
    expect(named()).toEqual(['Alice', 'Carol', 'Robert']);

    user.send({ type: 'remove_player', lobbyId, playerId: idOf('Alice') });
    expect(named()).toEqual(['Carol', 'Robert']);

    user.send({ type: 'start_match', lobbyId });
    expect(user.last('match_started')!.match.players.map((p) => p.name)).toEqual(['Carol', 'Robert']);
    expect(user.last('error')).toBeUndefined();
  });

  it('starts a match of one player', () => {
    // A lobby of one is a practice session. Allowed here today; Step 5 allows it everywhere.
    const { user, lobbyId } = lobbyOf(['Alice']);
    user.send({ type: 'start_match', lobbyId });
    expect(user.last('match_started')!.match.players).toHaveLength(1);
  });
});

describe('a lobby nobody was invited to', () => {
  it('is minted without a code, so there is nothing to join it by', () => {
    const { user, lobbyId } = lobbyOf(['Alice']);

    // Not minting one is the enforcement rather than a decoration. Joining is by code and only by
    // code, so a lobby without one cannot be named at all — its id is public (it is the spectate
    // URL) and buys nothing.
    expect(user.last('lobby_state')!.lobby.inviteCode).toBeNull();

    // The one thing a closed lobby does carry is `null`, and presenting that must not match it:
    // `lobby.inviteCode === code` is true of `null === null`, which would hand over the first
    // closed lobby on the server.
    const stranger = connect();
    stranger.send({ type: 'join_lobby', inviteCode: null });
    expect(stranger.last('error')?.message).toBe('Lobby not found');
    expect(getLobby(lobbyId)!.players).toHaveLength(1);

    // Watching is still open. A closed lobby is closed to players, not to an audience.
    stranger.send({ type: 'spectate', id: lobbyId });
    expect(stranger.last('lobby_state')!.youAreSpectator).toBe(true);
  });

  it('offers a code when it was opened, and takes the join', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    const inviteCode = host.last('lobby_state')!.lobby.inviteCode;
    expect(inviteCode).toBeTruthy();

    const guest = connect();
    guest.send({ type: 'join_lobby', inviteCode });
    guest.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
    expect(guest.last('error')).toBeUndefined();
    expect(getLobby(lobbyId)!.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);
  });
});

describe('one user reloading', () => {
  it('comes back holding every player, and the deferred leave does not walk it out', () => {
    vi.useFakeTimers();
    const { user, matchId, players } = startedOf(['Alice', 'Bob']);
    const token = user.resumeToken()!;

    // The socket closed. index.ts defers the leave by the grace period rather than running it, so a
    // reload has a window to come back — which is the whole reason a reload does not concede.
    user.ws.readyState = 3 as unknown as typeof user.ws.readyState;
    scheduleDisconnect(user.ws, () => { handleClientLeave(user.ws); removeClient(user.ws); });

    const returning = connect();
    returning.send({ type: 'reconnect', matchId, token });
    expect(heldSeat(matchId, returning.sessionId)!.seat.playerIds).toEqual(players.map((p) => p.id));
    expect(returning.spectator()).toBe(false);

    // Every player came back on one seat, so nothing is left for the deferred leave to take.
    vi.advanceTimersByTime(10_000);
    expect(getMatch(matchId)!.status).toBe('in_progress');
    expect(getMatch(matchId)!.departed).toEqual([]);

    // And the returning tab can still play both of them.
    returning.send({ type: 'add_dart', matchId, dart: T20 });
    expect(getMatch(matchId)!.currentVisit?.playerId).toBe(players[0].id);
  });
});
