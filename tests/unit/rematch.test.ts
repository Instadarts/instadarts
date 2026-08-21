import { describe, it, expect, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { handleMessage, registerClient, removeClient, handleClientLeave } from '../../src/server/wsHandler';
import { releaseRateLimit } from '../../src/server/rateLimit';
import type { ServerMessage } from '../../src/shared/protocol';
import '../helpers'; // registers the x01 mode

// ============================================================
// Harness — the real handlers, over a socket's worth of pretence
// ============================================================

let sessionCounter = 0;
const openSockets: WebSocket[] = [];

function connect() {
  const sessionId = `rm${++sessionCounter}`;
  const received: ServerMessage[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;

  registerClient(ws, { sessionId, lobbyId: null, matchId: null, playerIds: [], isSpectator: false, deviceId: null });
  openSockets.push(ws);

  return {
    ws,
    sessionId,
    received,
    send(msg: object) {
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(msg));
    },
    leave() {
      handleClientLeave(ws);
    },
    last<T extends ServerMessage['type']>(type: T) {
      const hits = received.filter((m) => m.type === type);
      return hits[hits.length - 1] as Extract<ServerMessage, { type: T }> | undefined;
    },
  };
}

type Conn = ReturnType<typeof connect>;

afterEach(() => {
  for (const ws of openSockets.splice(0)) removeClient(ws);
});

/** The latest match this connection has been told about, whichever message carried it. */
function matchOf(conn: Conn) {
  const carriers = conn.received.filter(
    (m) => m.type === 'match_state' || m.type === 'match_started' || m.type === 'match_finished',
  );
  const last = carriers[carriers.length - 1];
  return last && 'match' in last ? last.match : undefined;
}

/** Straight out from 180, so one visit of three trebles wins it. */
const QUICK_MATCH = { mode: 'x01', modeSettings: { startScore: 180, doubleIn: false, doubleOut: false } };
/** Centre of the treble 20 bed. */
const T20 = { x: 500_000, y: 726_000 };

/** Two players played by one user — one board, and no invite code offered. */
function localMatch() {
  const user = connect();
  user.send({ type: 'create_lobby', acceptsJoins: false });
  user.send({ type: 'add_local_player', playerName: 'Alice' });
  user.send({ type: 'add_local_player', playerName: 'Bob' });
  user.send({ type: 'update_settings', settings: QUICK_MATCH });
  user.send({ type: 'start_match' });
  return { user, match: () => matchOf(user)! };
}

/** Two users, one player each, in a lobby that took a join. */
function onlineMatch() {
  const host = connect();
  host.send({ type: 'create_lobby', acceptsJoins: true });
  host.send({ type: 'add_local_player', playerName: 'Alice' });

  const inviteCode = host.last('lobby_state')!.lobby.inviteCode!;
  const guest = connect();
  guest.send({ type: 'join_lobby', inviteCode, playerName: 'Bob' });
  guest.send({ type: 'add_local_player', playerName: 'Bob' });

  host.send({ type: 'update_settings', settings: QUICK_MATCH });
  host.send({ type: 'start_match' });
  return { host, guest, match: () => matchOf(host)! };
}

/**
 * A match this connection has been started into other than `exclude`.
 *
 * Needed because starting the original match also announces itself with `match_started`; "no
 * re-match has begun" is therefore about which match, not about whether a message arrived.
 */
function startedOther(conn: Conn, exclude: string) {
  const started = conn.received.filter((m) => m.type === 'match_started');
  const other = started.map((m) => (m as { match: { id: string } }).match).filter((m) => m.id !== exclude);
  return other[other.length - 1];
}

/** Whoever is up throws 180 and submits, which wins a straight-out match from 180. */
function winIt(conn: Conn, matchId: string) {
  for (let i = 0; i < 3; i++) conn.send({ type: 'add_dart', matchId, dart: T20 });
  conn.send({ type: 'submit_visit', matchId });
}

// ============================================================
// Tests
// ============================================================

describe('leaving a match', () => {
  it('cancels a local match: no winner, and the state says so', () => {
    const { user, match } = localMatch();
    expect(match().status).toBe('in_progress');

    user.leave();

    const finished = user.last('match_finished')!.match;
    expect(finished.status).toBe('finished');
    expect(finished.winnerId).toBeNull(); // cancelled, not won
    expect(finished.departed).toHaveLength(2);
  });

  it('hands an online match to the player who stayed', () => {
    const { host, guest, match } = onlineMatch();
    const [alice, bob] = match().players;

    host.leave();

    const finished = guest.last('match_finished')!.match;
    expect(finished.status).toBe('finished');
    expect(finished.winnerId).toBe(bob.id);
    expect(finished.departed).toEqual([alice.id]);
  });

  it('is final — a departed player cannot reconnect', () => {
    const { host, match } = onlineMatch();
    const matchId = match().id;
    // Everything the leaver's tab was holding, kept from before it walked out.
    const token = host.last('resume')!.token;

    host.leave();

    const returning = connect();
    returning.send({ type: 'reconnect', matchId, token });
    // Walking out gives up the place, so the token stands for nothing before anyone asks who it was.
    expect(returning.last('error')?.message).toBe('Cannot resume this session');
    expect(matchOf(returning)).toBeUndefined();
  });

  it('cannot be done to a match by the tab that was taken over', () => {
    // Duplicating a tab copies its sessionStorage, so two tabs can hold one token — and the second
    // to present it takes the place. The first is out of the match by then, so its Leave cannot
    // concede a match it is no longer in, which is the whole point of the place having one occupant.
    const { host, match } = onlineMatch();
    const matchId = match().id;
    const token = host.last('resume')!.token;

    const twin = connect();
    twin.send({ type: 'reconnect', matchId, token });
    expect(matchOf(twin)).toBeDefined();
    expect(host.last('seat_taken_over')).toBeDefined();

    host.leave();

    expect(match().status).toBe('in_progress');
    expect(match().departed).toEqual([]);
    // And the tab that holds the place still holds it.
    twin.send({ type: 'add_dart', matchId, dart: T20 });
    expect(matchOf(twin)!.currentVisit?.darts).toHaveLength(1);
  });

  it('takes the re-match off the table, even after the match was won', () => {
    const { host, guest, match } = onlineMatch();
    const matchId = match().id;
    winIt(host, matchId);
    expect(matchOf(guest)!.winnerId).toBe(matchOf(guest)!.players[0].id);

    // The loser closes the tab rather than answering.
    guest.leave();
    expect(matchOf(host)!.departed).toHaveLength(1);

    // Bob's leaving already stands as his answer, so nothing Alice does can start one.
    expect(matchOf(host)!.rematchVotes[matchOf(host)!.players[1].id]).toBe('declined');
    host.send({ type: 'rematch_vote', matchId, playerId: matchOf(host)!.players[0].id, answer: 'accepted' });
    expect(startedOther(host, matchId)).toBeUndefined();
  });
});

describe('re-match', () => {
  it('needs every player, and starts the moment it has them', () => {
    const { host, guest, match } = onlineMatch();
    const matchId = match().id;
    winIt(host, matchId);

    const [alice, bob] = matchOf(host)!.players;
    expect(matchOf(host)!.status).toBe('finished');

    host.send({ type: 'rematch_vote', matchId, playerId: alice.id, answer: 'accepted' });
    expect(matchOf(guest)!.rematchVotes).toEqual({ [alice.id]: 'accepted' }); // the other side sees it
    expect(startedOther(guest, matchId)).toBeUndefined();     // but nothing has started

    guest.send({ type: 'rematch_vote', matchId, playerId: bob.id, answer: 'accepted' });
    expect(startedOther(host, matchId)).toBeDefined();
    expect(startedOther(guest, matchId)).toBeDefined();
  });

  it('is a new match from scratch, with the order switched', () => {
    const { host, guest, match } = onlineMatch();
    const original = match();
    winIt(host, original.id);
    const [alice, bob] = original.players;

    host.send({ type: 'rematch_vote', matchId: original.id, playerId: alice.id, answer: 'accepted' });
    guest.send({ type: 'rematch_vote', matchId: original.id, playerId: bob.id, answer: 'accepted' });

    const rematch = startedOther(host, original.id)!;
    expect(rematch.id).not.toBe(original.id);
    expect(rematch.status).toBe('in_progress');
    expect(rematch.players.map((p) => p.name)).toEqual(['Bob', 'Alice']); // the other player begins
    expect(rematch.settings).toEqual(original.settings);                  // same rules

    // Nothing at all carries over.
    expect(rematch.visits).toEqual([]);
    expect(rematch.currentVisit).toBeUndefined();
    expect(rematch.winnerId).toBeNull();
    expect(rematch.finishedAt).toBeNull();
    expect(rematch.rematchVotes).toEqual({});
    expect(rematch.departed).toEqual([]);
  });

  it('leaves both users playing the new match', () => {
    const { host, guest, match } = onlineMatch();
    const original = match();
    winIt(host, original.id);
    const [alice, bob] = original.players;

    host.send({ type: 'rematch_vote', matchId: original.id, playerId: alice.id, answer: 'accepted' });
    guest.send({ type: 'rematch_vote', matchId: original.id, playerId: bob.id, answer: 'accepted' });
    const rematch = startedOther(host, original.id)!;

    // Bob leads off, and it is his own connection that may throw for him.
    winIt(guest, rematch.id);
    expect(matchOf(guest)!.winnerId).toBe(bob.id);
    expect(matchOf(host)!.id).toBe(rematch.id);
  });

  it('can be withdrawn before the other player answers', () => {
    const { host, guest, match } = onlineMatch();
    const matchId = match().id;
    winIt(host, matchId);
    const [alice, bob] = matchOf(host)!.players;

    host.send({ type: 'rematch_vote', matchId, playerId: alice.id, answer: 'accepted' });
    host.send({ type: 'rematch_vote', matchId, playerId: alice.id, answer: 'neutral' });
    expect(matchOf(guest)!.rematchVotes).toEqual({});

    guest.send({ type: 'rematch_vote', matchId, playerId: bob.id, answer: 'accepted' });
    expect(startedOther(guest, matchId)).toBeUndefined(); // one player is not enough
  });

  it('refuses a vote cast for somebody else', () => {
    const { host, guest, match } = onlineMatch();
    const matchId = match().id;
    winIt(host, matchId);
    const bob = matchOf(host)!.players[1];

    host.send({ type: 'rematch_vote', matchId, playerId: bob.id, answer: 'accepted' });
    expect(host.last('error')?.message).toBe('You can only answer for your own player');
    expect(matchOf(guest)!.rematchVotes).toEqual({});
  });

  it('is not offered while the match is still being played', () => {
    const { host, match } = onlineMatch();
    const matchId = match().id;
    const alice = match().players[0];

    host.send({ type: 'rematch_vote', matchId, playerId: alice.id, answer: 'accepted' });
    expect(matchOf(host)!.rematchVotes).toEqual({});
  });

  it('in a local match, the one user answers for both players', () => {
    const { user, match } = localMatch();
    const original = match();
    winIt(user, original.id);
    const [alice, bob] = original.players;

    user.send({ type: 'rematch_vote', matchId: original.id, playerId: alice.id, answer: 'accepted' });
    expect(startedOther(user, original.id)).toBeUndefined();

    user.send({ type: 'rematch_vote', matchId: original.id, playerId: bob.id, answer: 'accepted' });
    const rematch = startedOther(user, original.id)!;
    expect(rematch.players.map((p) => p.name)).toEqual(['Bob', 'Alice']);
  });
});

describe('a definitive answer', () => {
  it('is settled by one decline, and no later acceptance revives it', () => {
    const { host, guest, match } = onlineMatch();
    const matchId = match().id;
    winIt(host, matchId);
    const [alice, bob] = matchOf(host)!.players;

    guest.send({ type: 'rematch_vote', matchId, playerId: bob.id, answer: 'declined' });
    host.send({ type: 'rematch_vote', matchId, playerId: alice.id, answer: 'accepted' });

    expect(matchOf(host)!.rematchVotes).toEqual({ [bob.id]: 'declined', [alice.id]: 'accepted' });
    expect(startedOther(host, matchId)).toBeUndefined();
  });

  it('is what leaving means, so nobody can leave the question open', () => {
    const { host, guest, match } = onlineMatch();
    const matchId = match().id;
    winIt(host, matchId);
    const bob = matchOf(host)!.players[1];

    guest.leave();
    expect(matchOf(host)!.rematchVotes[bob.id]).toBe('declined');
  });

  it('cannot be cast for a player who has left', () => {
    const { host, guest, match } = onlineMatch();
    const matchId = match().id;
    winIt(host, matchId);
    const bob = matchOf(host)!.players[1];

    guest.leave();
    // Even the one user of a local match could not talk a departed player back in; here Alice tries
    // to answer for Bob, and is refused twice over.
    host.send({ type: 'rematch_vote', matchId, playerId: bob.id, answer: 'accepted' });
    expect(matchOf(host)!.rematchVotes[bob.id]).toBe('declined');
  });
});

describe('spectators', () => {
  it('are carried into the re-match', () => {
    const { host, guest, match } = onlineMatch();
    const original = match();
    winIt(host, original.id);

    const watcher = connect();
    watcher.send({ type: 'spectate', id: original.id });
    expect(matchOf(watcher)!.id).toBe(original.id);

    const [alice, bob] = original.players;
    host.send({ type: 'rematch_vote', matchId: original.id, playerId: alice.id, answer: 'accepted' });
    guest.send({ type: 'rematch_vote', matchId: original.id, playerId: bob.id, answer: 'accepted' });

    const rematch = startedOther(host, original.id)!;
    expect(matchOf(watcher)!.id).toBe(rematch.id); // followed along, still watching
  });
});
