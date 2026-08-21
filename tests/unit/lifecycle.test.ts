import { describe, it, expect, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { IDLE_TTL_MS, SUMMARY_TTL_MS, sweepLifecycle } from '../../src/server/lifecycle';
import { getMatch } from '../../src/server/store';
import type { ServerMessage } from '../../src/shared/protocol';
import '../helpers'; // registers the x01 mode

/**
 * The deadlines, exercised by standing at a point in the future rather than waiting for one.
 * `sweepLifecycle` takes `now` for exactly this reason.
 */

let sessionCounter = 0;
const openSockets: WebSocket[] = [];

function connect() {
  const sessionId = `lc${++sessionCounter}`;
  const received: ServerMessage[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;

  registerClient(ws, { sessionId, lobbyId: null, matchId: null, playerIds: [], isSpectator: false, deviceId: null });
  openSockets.push(ws);

  return {
    received,
    send(msg: object) {
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(msg));
    },
    has(type: ServerMessage['type']) {
      return received.some((m) => m.type === type);
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

function matchOf(conn: Conn) {
  const carriers = conn.received.filter(
    (m) => m.type === 'match_state' || m.type === 'match_started' || m.type === 'match_finished',
  );
  const last = carriers[carriers.length - 1];
  return last && 'match' in last ? last.match : undefined;
}

function lobby() {
  const user = connect();
  user.send({ type: 'create_lobby', isLocal: true });
  user.send({ type: 'add_local_player', playerName: 'Alice' });
  return user;
}

function match(settings?: object) {
  const user = lobby();
  user.send({ type: 'add_local_player', playerName: 'Bob' });
  if (settings) user.send({ type: 'update_settings', settings });
  user.send({ type: 'start_match' });
  return user;
}

/** Straight out from 180: one visit of three trebles wins it. */
const QUICK = { mode: 'x01', modeSettings: { startScore: 180, doubleIn: false, doubleOut: false } };
const T20 = { x: 500_000, y: 726_000 };

const soon = () => Date.now() + 1_000;
const afterIdle = () => Date.now() + IDLE_TTL_MS + 1_000;
const afterSummary = () => Date.now() + SUMMARY_TTL_MS + 1_000;

describe('idle timeouts', () => {
  it('leave a fresh lobby alone', () => {
    const user = lobby();
    sweepLifecycle(soon());
    expect(user.has('lobby_abandoned')).toBe(false);
  });

  it('abandon a lobby nobody has touched', () => {
    const user = lobby();
    sweepLifecycle(afterIdle());
    expect(user.has('lobby_abandoned')).toBe(true);
  });

  it('are pushed back by any input', () => {
    const user = lobby();
    const justBefore = Date.now() + IDLE_TTL_MS - 1_000;

    user.send({ type: 'set_player_name', playerId: 'p-unknown', name: 'Nobody' }); // still input
    sweepLifecycle(justBefore);
    expect(user.has('lobby_abandoned')).toBe(false);
  });

  it('cancel a match nobody is playing — finished, with no winner', () => {
    const user = match();
    sweepLifecycle(afterIdle());

    const finished = user.last('match_finished')!.match;
    expect(finished.status).toBe('finished');
    expect(finished.winnerId).toBeNull(); // cancelled
  });

  it('are pushed back by a dart', () => {
    const user = match();
    const matchId = matchOf(user)!.id;
    const justBefore = Date.now() + IDLE_TTL_MS - 1_000;

    user.send({ type: 'add_dart', matchId, dart: { x: 500_000, y: 726_000 } });
    sweepLifecycle(justBefore);
    expect(matchOf(user)!.status).toBe('in_progress');
  });
});

describe('the summary deadline', () => {
  it('applies to a cancelled match too, even though nobody is left to tell', () => {
    const user = match();
    const matchId = matchOf(user)!.id;
    user.send({ type: 'leave_match', matchId }); // the one user walks out: cancelled

    sweepLifecycle(soon());
    expect(getMatch(matchId)).toBeDefined(); // its summary is still running

    // Beyond the summary but well short of the idle period: a finished match must still go.
    sweepLifecycle(afterSummary());
    expect(getMatch(matchId)).toBeUndefined();
  });

  it('turns an unanswered re-match into a decline, then sends everyone home', () => {
    const user = match(QUICK);
    const played = matchOf(user)!;
    for (let i = 0; i < 3; i++) user.send({ type: 'add_dart', matchId: played.id, dart: T20 });
    user.send({ type: 'submit_visit', matchId: played.id });

    const finished = matchOf(user)!;
    expect(finished.status).toBe('finished');

    // One player answers, the other never does.
    user.send({ type: 'rematch_vote', matchId: finished.id, playerId: finished.players[0].id, answer: 'accepted' });

    sweepLifecycle(afterSummary());

    expect(user.has('match_closed')).toBe(true);
    expect(getMatch(finished.id)).toBeUndefined(); // gone from the server for good
  });

  it('is not pushed back by input, unlike the idle timeout', () => {
    const user = match(QUICK);
    const played = matchOf(user)!;
    for (let i = 0; i < 3; i++) user.send({ type: 'add_dart', matchId: played.id, dart: T20 });
    user.send({ type: 'submit_visit', matchId: played.id });
    const deadline = matchOf(user)!.expiresAt;

    // Voting is input, and it must not buy the match more time.
    user.send({ type: 'rematch_vote', matchId: played.id, playerId: played.players[0].id, answer: 'accepted' });
    expect(matchOf(user)!.expiresAt).toBe(deadline);
  });
});
