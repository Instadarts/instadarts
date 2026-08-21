import { describe, it, expect, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { IDLE_TTL_MS, SUMMARY_TTL_MS, sweepLifecycle } from '../../src/server/lifecycle';
import { getAllLobbies, getAllMatches } from '../../src/server/store';
import { sweepScoringSessions } from '../../src/server/scoring/store';
import type { ServerMessage } from '../../src/shared/protocol';
import '../helpers'; // registers the x01 mode

/**
 * Nothing outlives its deadline.
 *
 * The goal is not that some collector eventually notices an abandoned object — it is that no path
 * leaves one behind in the first place. So each of these plays a match to one of its endings, stands
 * far enough in the future for every deadline to have passed, and then asserts the stores are
 * *empty*, not merely small.
 *
 * `sweepScoringSessions` is asserted to find nothing at the end of each: a session outliving its
 * match would be a live throw-window timer holding a match object, which is the leak that would
 * matter most and the one hardest to see.
 */

let sessionCounter = 0;
const openSockets: WebSocket[] = [];

function connect() {
  const sessionId = `rt${++sessionCounter}`;
  const received: ServerMessage[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;

  registerClient(ws, { sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null });
  openSockets.push(ws);

  return {
    ws,
    send(msg: object) {
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(msg));
    },
  };
}

afterEach(() => {
  for (const ws of openSockets.splice(0)) removeClient(ws);
  // Whatever a case left behind must not be inherited by the next one.
  sweepLifecycle(Date.now() + IDLE_TTL_MS + SUMMARY_TTL_MS + 10_000);
  sweepScoringSessions();
});

const QUICK = { mode: 'x01', modeSettings: { startScore: 180, doubleIn: false, doubleOut: false } };
const T20 = { x: 500_000, y: 726_000 };

function lobby() {
  const user = connect();
  user.send({ type: 'create_lobby', acceptsJoins: false });
  user.send({ type: 'add_local_player', playerName: 'Alice' });
  return user;
}

function match() {
  const user = lobby();
  user.send({ type: 'add_local_player', playerName: 'Bob' });
  user.send({ type: 'update_settings', settings: QUICK });
  user.send({ type: 'start_match' });
  return user;
}

/** Long enough that every deadline in the system has passed, whatever state things are in. */
function longAfterEverything() {
  const t = Date.now() + IDLE_TTL_MS + SUMMARY_TTL_MS + 10_000;
  // Twice: cancelling an idle match gives it a summary deadline, which the next sweep collects.
  sweepLifecycle(t);
  sweepLifecycle(t);
}

/** What is still being held, once the dust has settled. */
function retained() {
  return {
    lobbies: getAllLobbies().size,
    matches: getAllMatches().size,
    scoringSessions: sweepScoringSessions(),
  };
}

describe('nothing outlives its deadline', () => {
  it('a lobby nobody ever used', () => {
    lobby();
    longAfterEverything();
    expect(retained()).toEqual({ lobbies: 0, matches: 0, scoringSessions: 0 });
  });

  it('a match nobody ever played', () => {
    match();
    longAfterEverything();
    expect(retained()).toEqual({ lobbies: 0, matches: 0, scoringSessions: 0 });
  });

  it('a match played to a win', () => {
    const user = match();
    user.send({ type: 'add_dart', dart: T20 });
    user.send({ type: 'add_dart', dart: T20 });
    user.send({ type: 'add_dart', dart: T20 });
    user.send({ type: 'submit_visit' });

    expect(getAllMatches().size).toBe(1); // still up, showing its summary
    longAfterEverything();
    expect(retained()).toEqual({ lobbies: 0, matches: 0, scoringSessions: 0 });
  });

  it('a match abandoned mid-visit, with darts in the board', () => {
    const user = match();
    user.send({ type: 'add_dart', dart: T20 });
    longAfterEverything();
    expect(retained()).toEqual({ lobbies: 0, matches: 0, scoringSessions: 0 });
  });

  it('a match whose player walked out', () => {
    const user = match();
    user.send({ type: 'leave_match' });
    longAfterEverything();
    expect(retained()).toEqual({ lobbies: 0, matches: 0, scoringSessions: 0 });
  });

  it('a re-match nobody answered', () => {
    const user = match();
    user.send({ type: 'add_dart', dart: T20 });
    user.send({ type: 'add_dart', dart: T20 });
    user.send({ type: 'add_dart', dart: T20 });
    user.send({ type: 'submit_visit' });
    user.send({ type: 'rematch_vote', playerId: getAllMatches().values().next().value!.players[0].id, answer: 'accepted' });

    longAfterEverything();
    expect(retained()).toEqual({ lobbies: 0, matches: 0, scoringSessions: 0 });
  });

  it('a client that vanished without saying anything', () => {
    const user = match();
    removeClient(user.ws);
    longAfterEverything();
    expect(retained()).toEqual({ lobbies: 0, matches: 0, scoringSessions: 0 });
  });

  it('several matches at once', () => {
    match(); match(); match();
    expect(getAllMatches().size).toBe(3);
    longAfterEverything();
    expect(retained()).toEqual({ lobbies: 0, matches: 0, scoringSessions: 0 });
  });
});
