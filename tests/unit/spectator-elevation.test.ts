import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { resetDeviceRegistry } from '../../src/server/devices';
import { resetScoringSessions } from '../../src/server/scoring/store';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { deleteLobby, deleteMatch, getAllLobbies, getAllMatches, getLobby, getMatch } from '../../src/server/store';
import type { ServerMessage } from '../../src/shared/protocol';
import type { Client } from '../../src/server/types';
import '../helpers'; // registers the x01 mode

/**
 * Regression coverage for turning spectator-visible state into a participant claim.
 *
 * The historical reconnect protocol accepted a match id and a player id without private proof.
 * Both ids appear in spectator-visible state, so a spectator could present them on a fresh socket
 * that had never been flagged `isSpectator`. Checking that flag alone did not establish ownership.
 *
 * The current protocol requires a private seat token, and gameplay guards require the session to
 * hold the seat in its room. The forged legacy messages below must be refused even on a connection
 * whose client record claims to be a participant. Public player ids are not credentials.
 *
 * Legitimate reload and takeover cases verify the other side: a new session presenting the real
 * token can resume its seat, and a replaced session loses authority. Spectators receive no token.
 */

let sessionCounter = 0;
const openSockets = new Set<WebSocket>();

/**
 * @param standing - What this connection's record claims about itself before it has done anything.
 *   Only the invariant tests pass one: it is how a connection that believes it belongs somewhere it
 *   never took a place is built.
 */
function connect(standing: Partial<Pick<Client, 'lobbyId' | 'matchId'>> = {}) {
  const sessionId = `s${++sessionCounter}`;
  const received: ServerMessage[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;

  registerClient(ws, {
    sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null, ...standing,
  });
  openSockets.add(ws);

  return {
    ws,
    sessionId,
    received,
    send(msg: object) {
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(msg));
    },
    last<T extends ServerMessage['type']>(type: T) {
      const hits = received.filter((m) => m.type === type);
      return hits[hits.length - 1] as Extract<ServerMessage, { type: T }> | undefined;
    },
    /** The tab going away. A page load closes its socket before the next one opens. */
    close() {
      removeClient(ws);
      openSockets.delete(ws);
    },
  };
}

type Conn = ReturnType<typeof connect>;

/** Anywhere on the board; the server recomputes the score from the coordinates anyway. */
const DART = { x: 500_000, y: 500_000 };

/** A local match — one user holding every player. A single-player match is this with one name. */
function localMatch(...names: string[]) {
  const host = connect();
  host.send({ type: 'create_lobby', acceptsJoins: false });
  for (const name of names) host.send({ type: 'add_local_player', playerName: name });
  host.send({ type: 'start_match' });
  const match = host.last('match_started')!.match;
  return { host, matchId: match.id, players: match.players };
}

/** An online match — two users, one player each. */
function onlineMatch() {
  const alice = connect();
  alice.send({ type: 'create_lobby', acceptsJoins: true });
  const lobbyId = alice.last('lobby_state')!.lobby.id;
  alice.send({ type: 'add_local_player', playerName: 'Alice' });

  const bob = connect();
  bob.send({ type: 'join_lobby', inviteCode: alice.last('lobby_state')!.lobby.inviteCode! });
  bob.send({ type: 'add_local_player', playerName: 'Bob' });

  alice.send({ type: 'start_match' });
  const match = alice.last('match_started')!.match;
  return { alice, bob, matchId: match.id, players: match.players };
}

/** Somebody who opened `/spectate/<id>`. */
function spectatorOf(matchId: string): Conn {
  const conn = connect();
  conn.send({ type: 'spectate', id: matchId });
  return conn;
}

/**
 * Editing the URL from `/spectate/<id>` to `/match/<id>`.
 *
 * Simulate the historical attack on a fresh socket by explicitly sending a forged legacy reconnect
 * with a public player id. The current frontend does not construct this message: a spectator has
 * no saved seat token, and changing the URL alone cannot make it a participant.
 */
function editUrlToMatch(spectator: Conn, matchId: string, playerId: string): Conn {
  spectator.close();
  const reloaded = connect();
  reloaded.send({ type: 'reconnect', matchId, playerId });
  return reloaded;
}

beforeEach(() => {
  resetDeviceRegistry();
  resetScoringSessions();
});

afterEach(() => {
  for (const ws of [...openSockets]) removeClient(ws);
  openSockets.clear();
  for (const id of [...getAllLobbies().keys()]) deleteLobby(id);
  for (const id of [...getAllMatches().keys()]) deleteMatch(id);
});

// ============================================================
// What a spectator is given
// ============================================================

describe('what watching a match tells you', () => {
  it('hands every spectator the player ids, which is the whole of what reconnect asks for', () => {
    const { matchId, players } = localMatch('Alice');
    const spec = spectatorOf(matchId);

    const seen = spec.last('match_state')!.match;
    expect(seen.players.map((p) => p.id)).toEqual(players.map((p) => p.id));
  });

  it('does not hand out the session id of the user those players belong to', () => {
    const { matchId } = localMatch('Alice', 'Bob');
    const spec = spectatorOf(matchId);

    for (const player of spec.last('match_state')!.match.players) {
      expect(player.sessionId).toBeUndefined();
    }
  });

  it('keeps it off a lobby too, and off the broadcast the players themselves get', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', playerName: 'Alice' });

    const spec = connect();
    spec.send({ type: 'spectate', id: lobbyId });

    for (const conn of [host, spec]) {
      for (const player of conn.last('lobby_state')!.lobby.players) {
        expect(player.sessionId).toBeUndefined();
      }
    }
    // What replaces it: which players are your own, told to one connection and to nobody else.
    expect(host.received.some((m) => m.type === 'lobby_state' && (m.yourPlayerIds?.length ?? 0) > 0)).toBe(true);
    expect(spec.received.some((m) => m.type === 'lobby_state' && (m.yourPlayerIds?.length ?? 0) > 0)).toBe(false);
  });

  it('does not hand out the creator\'s session id either', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;

    const spec = connect();
    spec.send({ type: 'spectate', id: lobbyId });

    for (const conn of [host, spec]) {
      expect(conn.last('lobby_state')!.lobby.hostSessionId).toBeUndefined();
    }
    // Being the creator is the server's answer to one connection, not a comparison anybody makes.
    expect(host.last('lobby_state')!.youAreHost).toBe(true);
    expect(spec.last('lobby_state')!.youAreHost).toBe(false);
  });

  it('tells a joiner it is not the host, and says nothing to the room', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', playerName: 'Alice' });

    const guest = connect();
    guest.send({ type: 'join_lobby', inviteCode: host.last('lobby_state')!.lobby.inviteCode! });
    expect(guest.last('lobby_state')!.youAreHost).toBe(false);

    // The broadcast that reaches the host when the guest joins settles nothing either way, so the
    // host's own answer is not overwritten by somebody else's arrival.
    guest.send({ type: 'add_local_player', playerName: 'Bob' });
    const broadcasts = host.received.filter((m) => m.type === 'lobby_state' && m.youAreHost === undefined);
    expect(broadcasts.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Local matches
// ============================================================

describe('a spectator of a local match', () => {
  it('cannot throw for the player by reloading onto /match/<id>', () => {
    // The reported case: a single-player match, whose one player the spectator is watching.
    const { matchId, players } = localMatch('Alice');
    const intruder = editUrlToMatch(spectatorOf(matchId), matchId, players[0].id);

    intruder.send({ type: 'add_dart', matchId, dart: DART });

    expect(getMatch(matchId)!.currentVisit).toBeUndefined();
  });

  it('does not take over the player\'s session on the way in', () => {
    // The quieter half of the same message: reconnect rebinds `player.sessionId` to whoever asked.
    // Everything that resolves a session to a player follows it — which scoring devices feed which
    // match, which cameras a user may drive — so the theft outlives the connection that did it.
    const { host, matchId, players } = localMatch('Alice');
    editUrlToMatch(spectatorOf(matchId), matchId, players[0].id);

    expect(getMatch(matchId)!.players[0].sessionId).toBe(host.sessionId);
  });

  it('cannot throw for either player of a two-player local match', () => {
    const { matchId, players } = localMatch('Alice', 'Bob');
    const intruder = editUrlToMatch(spectatorOf(matchId), matchId, players[1].id);

    intruder.send({ type: 'add_dart', matchId, dart: DART });

    expect(getMatch(matchId)!.currentVisit).toBeUndefined();
  });

  it('cannot submit the visit the real player is still throwing', () => {
    const { host, matchId, players } = localMatch('Alice', 'Bob');
    host.send({ type: 'add_dart', matchId, dart: DART });
    const intruder = editUrlToMatch(spectatorOf(matchId), matchId, players[0].id);

    intruder.send({ type: 'submit_visit', matchId });

    const match = getMatch(matchId)!;
    expect(match.visits).toHaveLength(0);
    expect(match.currentVisit?.darts).toHaveLength(1);
  });
});

// ============================================================
// Online matches
// ============================================================

describe('a spectator of an online match', () => {
  it('cannot throw for the player whose turn it is', () => {
    const { matchId, players } = onlineMatch();
    const intruder = editUrlToMatch(spectatorOf(matchId), matchId, players[0].id);

    intruder.send({ type: 'add_dart', matchId, dart: DART });

    expect(getMatch(matchId)!.currentVisit).toBeUndefined();
  });

  it('cannot end the match by walking out of it as somebody else', () => {
    // Leaving is final and it concedes: the walker is barred from coming back and the opponent takes
    // the match. A spectator who can leave as Bob can hand Alice a win Bob never conceded.
    const { matchId, players } = onlineMatch();
    const intruder = editUrlToMatch(spectatorOf(matchId), matchId, players[1].id);

    intruder.send({ type: 'leave_match', matchId });

    const match = getMatch(matchId)!;
    expect(match.status).toBe('in_progress');
    expect(match.winnerId).toBeNull();
    expect(match.departed).toEqual([]);
  });

  it('does not take over the opponent\'s session on the way in', () => {
    const { bob, matchId, players } = onlineMatch();
    editUrlToMatch(spectatorOf(matchId), matchId, players[1].id);

    expect(getMatch(matchId)!.players[1].sessionId).toBe(bob.sessionId);
  });
});

// ============================================================
// The same message, one phase earlier
// ============================================================

describe('a spectator of a local lobby', () => {
  it('cannot take the host seat by reloading onto /lobby/<id>', () => {
    // The historical lobby reconnect accepted a lobby id alone. Today the host seat requires its
    // private token, so knowing a local lobby's public id must not grant control of its settings.
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: false });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', playerName: 'Alice' });

    const spec = connect();
    spec.send({ type: 'spectate', id: lobbyId });
    spec.close();

    const intruder = connect();
    intruder.send({ type: 'reconnect', lobbyId });

    expect(getLobby(lobbyId)!.hostSessionId).toBe(host.sessionId);
  });
});

// ============================================================
// Without the reload
// ============================================================

describe('a spectator asking on the socket it is already watching from', () => {
  it('stays a spectator, and leaves the player\'s session where it was', () => {
    // The historical handler could also rebind a player's session from an existing spectator
    // socket. Reject the tokenless claim without changing either ownership or spectator status.
    const { host, matchId, players } = localMatch('Alice', 'Bob');
    const spec = spectatorOf(matchId);

    spec.send({ type: 'reconnect', matchId, playerId: players[0].id });
    spec.send({ type: 'add_dart', matchId, dart: DART });

    expect(getMatch(matchId)!.currentVisit).toBeUndefined();
    expect(getMatch(matchId)!.players[0].sessionId).toBe(host.sessionId);
  });
});

// ============================================================
// One place, one occupant
// ============================================================

describe('a duplicated tab', () => {
  /** What duplicating a tab does: the same token, in a second connection. */
  function duplicate(of: Conn, room: { lobbyId?: string; matchId?: string }): Conn {
    const copy = connect();
    copy.send({ type: 'reconnect', ...room, token: of.last('resume')!.token });
    return copy;
  }

  it('takes the place over, and the original is told', () => {
    const { host, matchId } = localMatch('Alice', 'Bob');

    const copy = duplicate(host, { matchId });

    expect(copy.last('match_state')).toBeDefined();
    expect(host.last('seat_taken_over')).toBeDefined();
  });

  it('leaves the original unable to throw, submit or leave', () => {
    const { host, matchId } = localMatch('Alice', 'Bob');
    duplicate(host, { matchId });

    host.send({ type: 'add_dart', matchId, dart: DART });
    host.send({ type: 'submit_visit', matchId });
    host.send({ type: 'leave_match', matchId });

    const match = getMatch(matchId)!;
    expect(match.currentVisit).toBeUndefined();
    expect(match.visits).toHaveLength(0);
    expect(match.status).toBe('in_progress');
    expect(match.departed).toEqual([]);
  });

  it('takes a lobby over too, chair and all', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', playerName: 'Alice' });

    const copy = duplicate(host, { lobbyId });
    expect(copy.last('lobby_state')!.youAreHost).toBe(true);
    expect(host.last('seat_taken_over')).toBeDefined();

    // The original cannot change the settings of a lobby it is no longer in.
    host.send({ type: 'update_settings', settings: { mode: 'x01', modeSettings: { startScore: 301, doubleIn: false, doubleOut: true } } });
    expect(getLobby(lobbyId)!.settings.modeSettings.startScore).toBe(501);
  });

  it('does not disturb two tabs that hold places of their own', () => {
    // The ordinary case this must not touch: separate tabs have separate storage, so they hold
    // separate seats and never contend for one. Two of them are two users.
    const { alice, bob, matchId, players } = onlineMatch();

    alice.send({ type: 'add_dart', matchId, dart: DART });
    expect(getMatch(matchId)!.currentVisit?.playerId).toBe(players[0].id);
    expect(alice.last('seat_taken_over')).toBeUndefined();
    expect(bob.last('seat_taken_over')).toBeUndefined();
  });

  it('is what a reload is not', () => {
    // This helper removes the old socket immediately, so only the returning socket can receive a
    // reply. The production disconnect-grace path is not exercised by this case.
    const { host, matchId } = localMatch('Alice', 'Bob');
    const token = host.last('resume')!.token;
    host.close();

    const reloaded = connect();
    reloaded.send({ type: 'reconnect', matchId, token });

    expect(reloaded.last('match_state')).toBeDefined();
    expect(reloaded.last('seat_taken_over')).toBeUndefined();
  });
});

describe('holding the place, not remembering it', () => {
  it('refuses a connection that believes it is in a match but holds no seat', () => {
    // The invariant itself, tested the only way it can be: a connection whose record says it is in
    // this match, which never took a place in it. Nothing legitimate produces this — it stands in
    // for whatever future path forgets to keep the two in step. `matchId` is the whole forgery:
    // a `Client` records the room it is in, and the players it holds live on its seat.
    const { matchId } = localMatch('Alice', 'Bob');

    const forged = connect({ matchId });
    forged.send({ type: 'add_dart', matchId, dart: DART });
    forged.send({ type: 'submit_visit', matchId });
    forged.send({ type: 'leave_match', matchId });

    const match = getMatch(matchId)!;
    expect(match.currentVisit).toBeUndefined();
    expect(match.visits).toHaveLength(0);
    expect(match.status).toBe('in_progress');
  });

  it('refuses a connection that believes it is in a lobby but holds no seat', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', playerName: 'Alice' });

    const forged = connect({ lobbyId });
    forged.send({ type: 'add_local_player', playerName: 'Mallory' });
    forged.send({ type: 'start_match' });

    expect(getLobby(lobbyId)!.players.map((p) => p.name)).toEqual(['Alice']);
    expect(getAllMatches().size).toBe(0);
  });
});

// ============================================================
// What the fix may not break
// ============================================================

describe('the real player reloading their own page', () => {
  it('resumes the match and goes on throwing', () => {
    // Why the hole is not simply "compare the session id": a reload mints a new one, so the server
    // cannot recognise the returning player by session either. What the real tab has and a watcher
    // has not is the token it was sent when it took its place.
    const { host, matchId } = localMatch('Alice', 'Bob');
    const token = host.last('resume')!.token;
    host.close();

    const reloaded = connect();
    reloaded.send({ type: 'reconnect', matchId, token });
    reloaded.send({ type: 'add_dart', matchId, dart: DART });

    expect(reloaded.last('match_state')).toBeDefined();
    expect(getMatch(matchId)!.currentVisit?.darts).toHaveLength(1);
  });

  it('comes back as the creator of an online lobby, and can still change its settings', () => {
    // The client no longer works this out by comparing session ids, so a reload has nothing of its
    // own to go on: being the creator has to survive in the seat and be said again on the way back.
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', playerName: 'Alice' });
    const token = host.last('resume')!.token;
    host.close();

    const reloaded = connect();
    reloaded.send({ type: 'reconnect', lobbyId, token });
    expect(reloaded.last('lobby_state')!.youAreHost).toBe(true);

    reloaded.send({ type: 'update_settings', settings: { mode: 'x01', modeSettings: { startScore: 301, doubleIn: false, doubleOut: true } } });
    expect(reloaded.last('error')).toBeUndefined();
    expect(getLobby(lobbyId)!.settings.modeSettings.startScore).toBe(301);
  });

  it('comes back as a guest without the creator\'s chair', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', playerName: 'Alice' });

    const guest = connect();
    guest.send({ type: 'join_lobby', inviteCode: host.last('lobby_state')!.lobby.inviteCode! });
    guest.send({ type: 'add_local_player', playerName: 'Bob' });
    const token = guest.last('resume')!.token;
    guest.close();

    const reloaded = connect();
    reloaded.send({ type: 'reconnect', lobbyId, token });

    expect(reloaded.last('lobby_state')!.youAreHost).toBe(false);
    expect(getLobby(lobbyId)!.hostSessionId).toBe(host.sessionId);
  });

  it('is told a token for the match it is carried into, not only for the lobby', () => {
    // The seat outlives the room id. A tab that reloads after the match starts names the match, so
    // it has to have been given the same seat under the new id.
    const { host, matchId } = localMatch('Alice');
    const resume = host.last('resume')!;

    expect(resume.matchId).toBe(matchId);
    expect(resume.token).toBeTruthy();
  });

  it('cannot be resumed with somebody else\'s token', () => {
    // Two rooms, two seats. A token is a place in one room and proves nothing about another.
    const other = localMatch('Carol');
    const { matchId } = localMatch('Alice', 'Bob');

    const intruder = connect();
    intruder.send({ type: 'reconnect', matchId, token: other.host.last('resume')!.token });
    intruder.send({ type: 'add_dart', matchId, dart: DART });

    expect(getMatch(matchId)!.currentVisit).toBeUndefined();
  });
});
