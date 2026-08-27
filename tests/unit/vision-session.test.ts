import { describe, it, expect, beforeEach } from 'vitest';
import { BOARD_CENTER } from '../../src/shared/scoring';
import { ScoringSession } from '../../src/server/scoring/session';
import { submitVisitToMatch } from '../../src/server/match';
import type { MatchState } from '../../src/shared/types';
import type { BoardTip } from '../../src/shared/vision/types';
import { makeMatch } from '../helpers';

// ============================================================
// Helpers
// ============================================================

function polar(radiusUnits: number, bearingDeg: number): [number, number] {
  const theta = (bearingDeg * Math.PI) / 180;
  return [
    Math.round(BOARD_CENTER + radiusUnits * Math.sin(theta)),
    Math.round(BOARD_CENTER + radiusUnits * Math.cos(theta)),
  ];
}

function tip(at: [number, number], confidence = 0.9): BoardTip {
  return { x: at[0], y: at[1], confidence };
}

const T20 = polar(226_000, 0);
const T20_GROUP: [number, number][] = [polar(226_000, -6), polar(226_000, 0), polar(232_000, 6)];
const S20 = polar(150_000, 0);
const D20 = polar(365_000, 0);
const S1 = polar(150_000, 18);

/**
 * A live match plus a session watching it, wired the way the server wires them: the session
 * re-resolves the match every time, and commits replace it.
 */
/**
 * `owner` is the players the frontend behind these cameras controls. The default is **both** of
 * `makeMatch`'s players — one user holding the whole roster, which is what a single-board match is.
 * An empty list is a frontend that holds none, and scores nothing.
 */
function harness(overrides: Parameters<typeof makeMatch>[0] = {}, owner: string[] = ['p1', 'p2']) {
  let match = makeMatch({ ...overrides });
  const commits: MatchState[] = [];
  const session = new ScoringSession({
    getMatch: () => match,
    ownerPlayerIds: owner,
    commit: (next) => {
      match = next;
      commits.push(next);
    },
  });
  session.setCameraActive('cam-a', true);

  return {
    session,
    commits,
    get match() {
      return match;
    },
    /** One inference from one camera, closing the window synchronously while it is the only one. */
    see(deviceId: string, ...tips: BoardTip[]) {
      session.addTips(deviceId, tips);
    },
    /** What a human pressing Submit in the UI does. */
    manualSubmit() {
      const result = submitVisitToMatch(match);
      if (result.success) match = result.match;
    },
    labels() {
      return (match.currentVisit?.darts ?? []).map((d) => d.score.label);
    },
  };
}

// ============================================================
// Darts in
// ============================================================

describe('ScoringSession — darts', () => {
  it('turns a throw into darts in the current visit', () => {
    const h = harness();
    h.see('cam-a', ...T20_GROUP.map((p) => tip(p)));
    expect(h.labels()).toEqual(['T20', 'T20', 'T20']);
    expect(h.commits).toHaveLength(1);
  });

  it('does not count darts that are still in the board on the next inference', () => {
    const h = harness();
    h.see('cam-a', tip(T20));
    h.see('cam-a', tip(T20));
    h.see('cam-a', tip(T20));
    expect(h.labels()).toEqual(['T20']);
  });

  it('never adds a fourth dart', () => {
    const h = harness();
    h.see('cam-a', ...T20_GROUP.map((p) => tip(p)));
    h.see('cam-a', ...T20_GROUP.map((p) => tip(p)), tip(S1));
    expect(h.labels()).toHaveLength(3);
  });

  it('ignores a device that has not declared its camera', () => {
    const h = harness();
    h.see('cam-ghost', tip(T20));
    expect(h.match.currentVisit).toBeUndefined();
  });

  it('does nothing when the match is not in progress', () => {
    const h = harness({ status: 'finished' });
    h.see('cam-a', tip(T20));
    expect(h.commits).toHaveLength(0);
  });
});

describe('ScoringSession — whose darts', () => {
  it('scores for the player who is up, when that player is its own', () => {
    const h = harness({ currentPlayerIndex: 0 }, ['p1']);
    h.see('cam-a', tip(T20));
    expect(h.match.currentVisit?.playerId).toBe('p1');
  });

  it('scores for any of its own players, so a user holding two of them scores for both turns', () => {
    // One board, two players standing at it. A user holding the whole roster is the same rule taken
    // to its end, and is what a single-board match looks like from here.
    const h = harness({ currentPlayerIndex: 1 }, ['p1', 'p2']);
    h.see('cam-a', tip(T20));
    expect(h.match.currentVisit?.playerId).toBe('p2');
  });

  it('refuses to score when it is somebody else\'s turn', () => {
    const h = harness({ currentPlayerIndex: 1 }, ['p1']);
    h.see('cam-a', tip(T20));
    expect(h.match.currentVisit).toBeUndefined();
    expect(h.commits).toHaveLength(0);
  });

  it('still tracks a dart it was not allowed to score, so it is not offered later', () => {
    const h = harness({ currentPlayerIndex: 1 }, ['p1']);
    h.see('cam-a', tip(T20));
    expect(h.session.trackedDarts).toBe(1);
  });

  it('refuses to score for an owner with no player', () => {
    const h = harness({}, []);
    h.see('cam-a', tip(T20));
    expect(h.commits).toHaveLength(0);
  });
});

// ============================================================
// Takeout
// ============================================================

describe('ScoringSession — takeout', () => {
  it('submits the visit when the darts come out', () => {
    const h = harness();
    h.see('cam-a', ...T20_GROUP.map((p) => tip(p)));
    expect(h.match.visits).toHaveLength(0);

    h.see('cam-a'); // empty board
    expect(h.match.visits).toHaveLength(1);
    expect(h.match.visits[0].darts.map((d) => d.score.label)).toEqual(['T20', 'T20', 'T20']);
    expect(h.match.currentVisit).toBeUndefined();
  });

  it('does NOT submit a full visit while the darts are still in the board', () => {
    const h = harness();
    h.see('cam-a', ...T20_GROUP.map((p) => tip(p)));
    h.see('cam-a', ...T20_GROUP.map((p) => tip(p)));
    expect(h.match.visits).toHaveLength(0);
    expect(h.labels()).toHaveLength(3);
  });

  it('never submits an empty visit — a camera on an empty board does not play the match', () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.see('cam-a');
    expect(h.match.visits).toHaveLength(0);
    expect(h.match.currentPlayerIndex).toBe(0);
    expect(h.commits).toHaveLength(0);
  });

  it('two empty windows in a row still produce one submit', () => {
    const h = harness();
    h.see('cam-a', ...T20_GROUP.map((p) => tip(p)));
    h.see('cam-a');
    h.see('cam-a');
    h.see('cam-a');
    expect(h.match.visits).toHaveLength(1);
  });

  it('arms at two darts with one camera', () => {
    const h = harness();
    h.see('cam-a', tip(T20));
    h.see('cam-a'); // one dart is not enough to believe an empty board
    expect(h.match.visits).toHaveLength(0);

    h.see('cam-a', tip(T20), tip(S1));
    h.see('cam-a');
    expect(h.match.visits).toHaveLength(1);
  });

  it('arms at one dart with two cameras agreeing', () => {
    const h = harness();
    h.session.setCameraActive('cam-b', true);
    h.see('cam-a', tip(T20));
    h.see('cam-b', tip(T20));
    expect(h.labels()).toEqual(['T20']);

    h.see('cam-a');
    expect(h.match.visits).toHaveLength(0); // one camera's word is not enough
    h.see('cam-b');
    expect(h.match.visits).toHaveLength(1);
  });

  it('arms at one dart once the visit is locked by a checkout', () => {
    const h = harness({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 40 } });
    h.see('cam-a', tip(D20));
    expect(h.match.currentVisit?.locked).toBe(true);

    h.see('cam-a');
    // The checkout won the leg, so it is that leg's last visit rather than a loose one.
    expect(h.match.visits).toHaveLength(0);
    expect(h.match.legs[0].visits).toHaveLength(1);
    expect(h.match.status).toBe('finished');
    expect(h.match.winnerId).toBe('p1');
  });

  it('arms at one dart when the visit is already arithmetically bust', () => {
    // 21 left, a single 20 leaves 1 — bust, and the player pulls early.
    const h = harness({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 21 } });
    h.see('cam-a', tip(S20));
    expect(h.labels()).toEqual(['S20']);

    h.see('cam-a');
    expect(h.match.visits).toHaveLength(1);
    expect(h.match.visits[0].voided).toBe(true);
    expect(h.match.currentPlayerIndex).toBe(1);
  });

  it('does not take a single camera\'s word for an empty board when two are watching', () => {
    const h = harness();
    h.session.setCameraActive('cam-b', true);
    h.see('cam-a', tip(T20));
    h.see('cam-b', tip(T20));
    h.see('cam-a', tip(T20)); // cam-a still sees it
    h.see('cam-b'); // cam-b lost the board
    expect(h.match.visits).toHaveLength(0);
  });

  it('a camera that goes away releases the visit it was holding open', () => {
    const h = harness();
    h.session.setCameraActive('cam-b', true);
    h.see('cam-a', tip(T20));
    h.see('cam-b', tip(T20));
    h.see('cam-a', tip(S1));
    h.see('cam-b', tip(S1));
    expect(h.labels()).toEqual(['T20', 'S1']);

    // The board is cleared, but cam-b's phone has gone to sleep and its report never arrives.
    h.see('cam-a');
    expect(h.match.visits).toHaveLength(0);

    // Once it is gone for good the window it was blocking closes, and unanimity is now a claim
    // about cam-a alone — which has already said the board is empty.
    h.session.setCameraActive('cam-b', false);
    expect(h.match.visits).toHaveLength(1);
  });
});

// ============================================================
// Living alongside the human
// ============================================================

describe('ScoringSession — alongside manual scoring', () => {
  it('a manual submit ends the tracking along with the visit', () => {
    const h = harness();
    h.see('cam-a', ...T20_GROUP.map((p) => tip(p)));
    h.manualSubmit();
    expect(h.match.currentPlayerIndex).toBe(1);

    // Tracked darts are per-visit. The board is cleared before the next one starts, so Bob's throw
    // into the same treble is his own — not a re-sighting of Alice's.
    h.see('cam-a', ...T20_GROUP.map((p) => tip(p)));
    expect(h.match.currentVisit?.playerId).toBe('p2');
    expect(h.labels()).toEqual(['T20', 'T20', 'T20']);
  });

  it('a visit that ends without the camera noticing still resets it', () => {
    // A bust ends the visit through the ordinary rules rather than through a takeout.
    const h = harness({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 121 } });
    h.see('cam-a', ...T20_GROUP.map((p) => tip(p))); // 180 into 121 — bust
    h.manualSubmit();
    expect(h.match.visits[0].voided).toBe(true);

    // Bob throws into the same treble Alice just busted in, which only counts if her darts were
    // forgotten with her visit.
    h.see('cam-a', tip(T20_GROUP[0]));
    expect(h.match.currentVisit?.playerId).toBe('p2');
    expect(h.labels()).toEqual(['T20']);
  });

  it('an empty board it did not believe leaves the tracking alone', () => {
    const h = harness();
    h.see('cam-a', tip(T20));
    h.see('cam-a'); // one dart is below the arm threshold, so nothing is submitted
    expect(h.match.visits).toHaveLength(0);
    // The visit did not end, so neither did the tracking. Forgetting the dart here would mean
    // believing a read we have just refused to believe.
    expect(h.session.trackedDarts).toBe(1);

    // Which matters because the likely explanation is that the dart is still in the board and this
    // one inference missed it. The next one sees it again, and it must not score twice.
    h.see('cam-a', tip(T20));
    expect(h.labels()).toEqual(['T20']);
  });

  it('after a manual submit and a real takeout, the next player scores normally', () => {
    const h = harness();
    h.see('cam-a', ...T20_GROUP.map((p) => tip(p)));
    h.manualSubmit();
    h.see('cam-a'); // board cleared, and the new visit has nothing to submit
    expect(h.match.visits).toHaveLength(1);

    h.see('cam-a', tip(S20));
    expect(h.match.currentVisit?.playerId).toBe('p2');
    expect(h.labels()).toEqual(['S20']);
  });

  it('a corrected dart is not re-added by the camera that misread it', () => {
    const h = harness();
    h.see('cam-a', tip(T20));
    // The scorer decides it was actually an S20 and fixes it by hand: undo, then enter the right
    // one. The physical dart is still in the board and still tracked.
    const undone = { ...h.match, currentVisit: undefined };
    h.commits.push(undone);

    h.see('cam-a', tip(T20));
    expect(h.session.trackedDarts).toBe(1);
  });
});
