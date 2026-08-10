import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { resetDeviceRegistry } from '../../src/server/devices';
import { resetScoringSessions } from '../../src/server/scoring/store';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { deleteLobby, deleteMatch, getAllLobbies, getAllMatches, getLobby, getMatch } from '../../src/server/store';
import type { ServerMessage } from '../../src/shared/protocol';
import '../helpers'; // registers the x01 mode

/**
 * Whether watching a match can be turned into playing it.
 *
 * `requireMatch` refuses every input from a connection flagged `isSpectator`, and that flag is the
 * only thing between an audience and the board. So the question these tests ask is not "does the
 * flag work" but **"can a spectator get a connection that never had the flag set?"** — which is
 * exactly what editing `/spectate/<id>` to `/match/<id>` in the address bar produces: a page load, a
 * brand-new socket, and the `reconnect` the frontend sends on open.
 *
 * `reconnect` is an identity claim carrying no proof: a match id and a player id, both of which
 * every spectator is handed in the ordinary match broadcast. That makes these tests about the
 * message, not about the flag.
 *
 * The last test is the one that constrains the fix rather than describing the bug. A page reload
 * mints a *new session id*, so the server cannot recognise the real player by session either — the
 * legitimate tab has to present something a spectator has never been given.
 */

let sessionCounter = 0;
const openSockets = new Set<WebSocket>();

function connect() {
  const sessionId = `s${++sessionCounter}`;
  const received: ServerMessage[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;

  registerClient(ws, { sessionId, lobbyId: null, matchId: null, playerId: null, isSpectator: false, deviceId: null });
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
  host.send({ type: 'create_lobby', isLocal: true });
  for (const name of names) host.send({ type: 'add_local_player', playerName: name });
  host.send({ type: 'start_match' });
  const match = host.last('match_started')!.match;
  return { host, matchId: match.id, players: match.players };
}

/** An online match — two users, one player each. */
function onlineMatch() {
  const alice = connect();
  alice.send({ type: 'create_lobby', isLocal: false });
  const lobbyId = alice.last('lobby_state')!.lobby.id;
  alice.send({ type: 'add_local_player', playerName: 'Alice' });

  const bob = connect();
  bob.send({ type: 'join_lobby', lobbyId });
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
 * The browser loads the page again: the spectating socket closes, a new one opens under a new
 * session id, and the frontend resumes the session its tab saved. All the attacker supplies is a
 * player id, and the match state they were watching is where they read it.
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
    host.send({ type: 'create_lobby', isLocal: false });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', playerName: 'Alice' });

    const spec = connect();
    spec.send({ type: 'spectate', id: lobbyId });

    for (const conn of [host, spec]) {
      for (const player of conn.last('lobby_state')!.lobby.players) {
        expect(player.sessionId).toBeUndefined();
      }
    }
    // What replaces it: which player is your own, told to one connection and to nobody else.
    expect(host.received.some((m) => m.type === 'lobby_state' && m.yourPlayerId)).toBe(true);
    expect(spec.received.some((m) => m.type === 'lobby_state' && m.yourPlayerId)).toBe(false);
  });

  it('does not hand out the creator\'s session id either', () => {
    const host = connect();
    host.send({ type: 'create_lobby', isLocal: false });
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
    host.send({ type: 'create_lobby', isLocal: false });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', playerName: 'Alice' });

    const guest = connect();
    guest.send({ type: 'join_lobby', lobbyId });
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
    // The lobby branch of `reconnect` has the identical hole, and a local lobby gives the seat away
    // without even a player id to name. The host seat is who may change the settings and remove
    // players, so it is worth as much as a turn at the board.
    const host = connect();
    host.send({ type: 'create_lobby', isLocal: true });
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
    // No reload needed for the second half: the `isSpectator` flag survives on this socket and still
    // refuses the darts, but the same unproven claim rebinds the player to this session regardless.
    const { host, matchId, players } = localMatch('Alice', 'Bob');
    const spec = spectatorOf(matchId);

    spec.send({ type: 'reconnect', matchId, playerId: players[0].id });
    spec.send({ type: 'add_dart', matchId, dart: DART });

    expect(getMatch(matchId)!.currentVisit).toBeUndefined();
    expect(getMatch(matchId)!.players[0].sessionId).toBe(host.sessionId);
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
    host.send({ type: 'create_lobby', isLocal: false });
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
    host.send({ type: 'create_lobby', isLocal: false });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', playerName: 'Alice' });

    const guest = connect();
    guest.send({ type: 'join_lobby', lobbyId });
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
