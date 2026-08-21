import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { resetDeviceRegistry } from '../../src/server/devices';
import { resetScoringSessions } from '../../src/server/scoring/store';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { BOARD_CENTER } from '../../src/shared/scoring';
import { validateTips } from '../../src/server/validation';
import type { MatchState } from '../../src/shared/types';
import type { ServerMessage } from '../../src/shared/protocol';
import type { BoardTip } from '../../src/shared/vision/types';
import '../helpers'; // registers the x01 mode

// ============================================================
// Harness
// ============================================================

let sessionCounter = 0;
const openSockets: WebSocket[] = [];

function connect() {
  const sessionId = `s${++sessionCounter}`;
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
  };
}

type Conn = ReturnType<typeof connect>;

/** Pair a scoring device to a frontend connection and grab it for that session. */
function pairTo(frontend: Conn) {
  frontend.send({ type: 'create_pairing_code' });
  const code = frontend.last('pairing_code')!.code;

  const scorer = connect();
  scorer.send({ type: 'scorer_pair', code });
  const { deviceId, token } = scorer.last('scorer_paired')!;
  const { tokenHash } = frontend.last('device_paired')!;
  frontend.send({ type: 'activate_devices', devices: [{ deviceId, tokenHash, grabbedAt: 1 }] });

  return { scorer, deviceId, token, tokenHash };
}

/**
 * A frontend, a scoring device paired to it, and a match the frontend is playing in — built
 * through the real handlers, so the client bookkeeping is the real bookkeeping.
 *
 * `startScore` must be a legal one (101–999); anything else is silently ignored by validateSettings
 * and the match quietly starts at 501.
 */
function setup(options: { oneBoard?: boolean; startScore?: number } = {}) {
  const oneBoard = options.oneBoard !== false;
  const frontend = connect();
  const { scorer, deviceId, token, tokenHash } = pairTo(frontend);

  frontend.send({ type: 'create_lobby', acceptsJoins: !oneBoard });
  frontend.send({ type: 'add_local_player', playerName: 'Alice' });

  let opponent: Conn | null = null;
  if (oneBoard) {
    frontend.send({ type: 'add_local_player', playerName: 'Bob' });
  } else {
    // Two boards means two users, so the opponent needs a connection of their own.
    const inviteCode = frontend.last('lobby_state')!.lobby.inviteCode!;
    opponent = connect();
    opponent.send({ type: 'join_lobby', inviteCode, playerName: 'Bob' });
    opponent.send({ type: 'add_local_player', playerName: 'Bob' });
  }

  if (options.startScore) {
    frontend.send({
      type: 'update_settings',
      settings: { mode: 'x01', modeSettings: { startScore: options.startScore, doubleIn: false, doubleOut: true } },
    });
  }
  frontend.send({ type: 'start_match' });

  const match = () => frontend.last('match_state')?.match ?? frontend.last('match_started')!.match;

  scorer.send({ type: 'scorer_camera', active: true });

  return { frontend, opponent, scorer, deviceId, token, tokenHash, match };
}

function tips(scorer: Conn, ...points: [number, number][]) {
  scorer.send({
    type: 'scorer_tips',
    tips: points.map(([x, y]): BoardTip => ({ x, y, confidence: 0.9 })),
  });
}

function polar(radiusUnits: number, bearingDeg: number): [number, number] {
  const theta = (bearingDeg * Math.PI) / 180;
  return [
    Math.round(BOARD_CENTER + radiusUnits * Math.sin(theta)),
    Math.round(BOARD_CENTER + radiusUnits * Math.cos(theta)),
  ];
}

const T20_GROUP: [number, number][] = [polar(226_000, -6), polar(226_000, 0), polar(232_000, 6)];
const T20 = polar(226_000, 0);
const DB: [number, number] = [BOARD_CENTER, BOARD_CENTER];

function visitLabels(match: MatchState): string[] {
  return (match.currentVisit?.darts ?? []).map((d) => d.score.label);
}

beforeEach(() => {
  resetDeviceRegistry();
  resetScoringSessions();
});

afterEach(() => {
  for (const ws of openSockets.splice(0)) removeClient(ws);
  resetDeviceRegistry();
  resetScoringSessions();
});

// ============================================================
// The path that works
// ============================================================

describe('camera darts', () => {
  it('a throw the camera sees becomes darts in the visit', () => {
    const { scorer, match } = setup();
    tips(scorer, ...T20_GROUP);

    expect(visitLabels(match())).toEqual(['T20', 'T20', 'T20']);
  });

  it('the frontend is told, exactly as it would be for a manual dart', () => {
    const { frontend, scorer } = setup();
    const before = frontend.received.filter((m) => m.type === 'match_state').length;
    tips(scorer, ...T20_GROUP);
    expect(frontend.received.filter((m) => m.type === 'match_state').length).toBe(before + 1);
  });

  it('clearing the board submits the visit', () => {
    const { scorer, match } = setup();
    tips(scorer, ...T20_GROUP);
    tips(scorer);

    expect(match().visits).toHaveLength(1);
    expect(match().visits[0].darts.map((d) => d.score.label)).toEqual(['T20', 'T20', 'T20']);
    expect(match().currentPlayerIndex).toBe(1);
  });

  it('a camera can win a leg', () => {
    // 110: T20 then bull, which is a legal double-out finish.
    const { scorer, match } = setup({ startScore: 110 });
    tips(scorer, T20, DB);
    expect(match().currentVisit!.locked).toBe(true);

    tips(scorer);
    expect(match().status).toBe('finished');
    expect(match().winnerId).toBe(match().players[0].id);
  });

  it('the scoring device knows it is actively scoring', () => {
    const { scorer } = setup({ startScore: 501 });
    tips(scorer, ...T20_GROUP);

    const state = scorer.last('scorer_state')!;
    expect(state.status).toBe('active');
    expect(state.cameras).toBe(1);
  });

  it('manual and camera darts share one visit', () => {
    const { frontend, scorer, match } = setup();
    frontend.send({ type: 'add_dart', dart: { x: polar(150_000, 0)[0], y: polar(150_000, 0)[1] } });
    tips(scorer, T20_GROUP[0]);

    expect(visitLabels(match())).toEqual(['S20', 'T20']);
  });

  it('a manual submit hands the next player a clean board', () => {
    const { frontend, scorer, match } = setup();
    tips(scorer, ...T20_GROUP);
    frontend.send({ type: 'submit_visit' });
    expect(match().currentPlayerIndex).toBe(1);

    // Tracked darts belong to the visit that is over. Bob's throw into the same treble is his.
    tips(scorer, ...T20_GROUP);
    expect(match().currentVisit?.playerId).toBe(match().players[1].id);
    expect(visitLabels(match())).toEqual(['T20', 'T20', 'T20']);
  });

  it('a dart corrected by hand is not re-added by the camera that misread it', () => {
    const { frontend, scorer, match } = setup();
    tips(scorer, T20_GROUP[0]);
    expect(visitLabels(match())).toEqual(['T20']);

    frontend.send({ type: 'undo_dart' });
    frontend.send({ type: 'add_dart', dart: { x: polar(150_000, 0)[0], y: polar(150_000, 0)[1] } });
    expect(visitLabels(match())).toEqual(['S20']);

    // The physical dart is still in the board and the camera still sees it.
    tips(scorer, T20_GROUP[0]);
    expect(visitLabels(match())).toEqual(['S20']);
  });
});

// ============================================================
// Everything that must not score
// ============================================================

describe('camera darts — refusals', () => {
  it('tips from a socket that never identified itself do nothing', () => {
    const { match } = setup();
    const stranger = connect();
    stranger.send({ type: 'scorer_tips', tips: [{ x: T20_GROUP[0][0], y: T20_GROUP[0][1], confidence: 0.9 }] });

    expect(match().currentVisit).toBeUndefined();
  });

  it('tips from a paired device no frontend is holding do nothing', () => {
    const { frontend, scorer, deviceId, match } = setup();
    frontend.send({ type: 'deactivate_device', deviceId });

    tips(scorer, ...T20_GROUP);
    expect(match().currentVisit).toBeUndefined();
  });

  it('tips do nothing while the owner is not in a match', () => {
    const frontend = connect();
    frontend.send({ type: 'create_pairing_code' });
    const scorer = connect();
    scorer.send({ type: 'scorer_pair', code: frontend.last('pairing_code')!.code });
    const { deviceId } = scorer.last('scorer_paired')!;
    frontend.send({
      type: 'activate_devices',
      devices: [{ deviceId, tokenHash: frontend.last('device_paired')!.tokenHash, grabbedAt: 1 }],
    });
    scorer.send({ type: 'scorer_camera', active: true });

    tips(scorer, ...T20_GROUP);
    expect(scorer.last('scorer_state')!.status).toBe('active');
  });

  it('a spectator with a camera is not a scorer', () => {
    const { frontend, scorer, match } = setup();
    const matchId = match().id;

    // The owner is now watching someone else's match rather than playing in one.
    const watcher = connect();
    watcher.send({ type: 'spectate', id: matchId });

    // Its own devices are the ones under test: re-pair to the spectating connection.
    watcher.send({ type: 'create_pairing_code' });
    const spy = connect();
    spy.send({ type: 'scorer_pair', code: watcher.last('pairing_code')!.code });
    const paired = spy.last('scorer_paired')!;
    watcher.send({
      type: 'activate_devices',
      devices: [{ deviceId: paired.deviceId, tokenHash: watcher.last('device_paired')!.tokenHash, grabbedAt: 1 }],
    });
    spy.send({ type: 'scorer_camera', active: true });

    tips(spy, ...T20_GROUP);
    expect(match().currentVisit).toBeUndefined();

    // And the real device still works.
    tips(scorer, T20_GROUP[0]);
    expect(visitLabels(match())).toEqual(['T20']);
    void frontend;
  });

  it('an online camera does not score on the opponent\'s turn', () => {
    const { frontend, scorer, match } = setup({ oneBoard: false });
    expect(match().players).toHaveLength(2);

    // It is Alice's turn and the camera belongs to Alice's browser, so her throw lands.
    tips(scorer, ...T20_GROUP);
    expect(visitLabels(match())).toEqual(['T20', 'T20', 'T20']);

    // She clears the board, which ends her visit and hands the turn to Bob.
    tips(scorer);
    expect(match().currentPlayerIndex).toBe(1);

    // Whatever Alice's camera sees now is not Bob's throw — he is at his own board.
    tips(scorer, T20);
    expect(match().currentVisit).toBeUndefined();
    void frontend;
  });

  it('a device that stopped its camera stops being counted', () => {
    const { scorer, match } = setup();
    scorer.send({ type: 'scorer_camera', active: false });
    tips(scorer, ...T20_GROUP);
    expect(match().currentVisit).toBeUndefined();
  });
});

// ============================================================
// The wire itself
// ============================================================

describe('validateTips', () => {
  const good = { x: 500_000, y: 500_000, confidence: 0.9 };

  it('accepts an empty report — that is the takeout signal, not an error', () => {
    expect(validateTips([])).toEqual([]);
  });

  it('accepts a well-formed report', () => {
    expect(validateTips([good])).toEqual([good]);
  });

  it('drops the whole report rather than salvaging part of it', () => {
    // The critical property: a bad report must never come back as [], which would read as a takeout.
    for (const bad of [
      [good, { x: 'nope', y: 1, confidence: 0.5 }],
      [good, { x: NaN, y: 1, confidence: 0.5 }],
      [good, { x: Infinity, y: 1, confidence: 0.5 }],
      [good, { x: -1, y: 1, confidence: 0.5 }],
      [good, { x: 1_000_001, y: 1, confidence: 0.5 }],
      [good, { x: 1, y: -0.001, confidence: 0.5 }],
      [good, { x: 1, y: 1, confidence: 1.5 }],
      [good, { x: 1, y: 1, confidence: -0.1 }],
      [good, null],
      [good, 'tip'],
      [good, []],
    ]) {
      expect(validateTips(bad)).toBeNull();
    }
  });

  it('rejects things that are not reports', () => {
    expect(validateTips(null)).toBeNull();
    expect(validateTips('[]')).toBeNull();
    expect(validateTips({ tips: [] })).toBeNull();
    expect(validateTips(42)).toBeNull();
  });

  it('rejects a report too large to have come from the model', () => {
    expect(validateTips(Array.from({ length: 25 }, () => good))).toBeNull();
    expect(validateTips(Array.from({ length: 24 }, () => good))).toHaveLength(24);
  });

  it('a malformed report changes nothing and does not end the visit', () => {
    const { scorer, match } = setup();
    tips(scorer, ...T20_GROUP);
    expect(visitLabels(match())).toHaveLength(3);

    scorer.send({ type: 'scorer_tips', tips: [{ x: -5, y: 0, confidence: 0.9 }] });
    scorer.send({ type: 'scorer_tips', tips: 'garbage' });
    scorer.send({ type: 'scorer_tips' });

    expect(match().visits).toHaveLength(0);
    expect(visitLabels(match())).toHaveLength(3);
  });
});
