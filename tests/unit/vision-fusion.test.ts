import { describe, it, expect } from 'vitest';
import { BOARD_CENTER } from '../../src/shared/scoring';
import { REPEAT_FILTER_RADIUS, THROW_WINDOW_DART_RADIUS } from '../../src/shared/vision/constants';
import { clusterNewTips, filterKnownTips, rankCandidates } from '../../src/server/scoring/cluster';
import { DartTracker } from '../../src/server/scoring/tracker';
import { ThrowWindows, THROW_WINDOW_MAX_MS } from '../../src/server/scoring/throwWindow';
import type { TipReport, WindowResult } from '../../src/server/scoring/throwWindow';
import type { BoardTip, DartPoint } from '../../src/shared/vision/types';

// ============================================================
// Helpers
// ============================================================

/** Board coordinate at radius r on a bearing clockwise from straight up. */
function polar(radiusUnits: number, bearingDeg: number): [number, number] {
  const theta = (bearingDeg * Math.PI) / 180;
  return [
    Math.round(BOARD_CENTER + radiusUnits * Math.sin(theta)),
    Math.round(BOARD_CENTER + radiusUnits * Math.cos(theta)),
  ];
}

const T20 = polar(226_000, 0);
const T19 = polar(226_000, 126);
const S20 = polar(150_000, 0);

/**
 * Three darts grouped in the treble 20 bed, spread across its width the way real ones are.
 * THROW_WINDOW_DART_RADIUS is 5.6mm, so anything tighter than that is genuinely indistinguishable
 * from one dart seen twice — the ±6° here is about 9mm apart, a good group but not an impossible one.
 */
const T20_GROUP: [number, number][] = [polar(226_000, -6), polar(226_000, 0), polar(232_000, 6)];

function tip(at: [number, number], confidence = 0.9): BoardTip {
  return { x: at[0], y: at[1], confidence };
}

/** Same physical dart, seen a couple of millimetres off by another camera. */
function nudged(at: [number, number], byUnits: number): [number, number] {
  return [at[0] + byUnits, at[1]];
}

function point(at: [number, number], deviceId: string, confidence = 0.9): DartPoint {
  return { x: at[0], y: at[1], confidence, deviceId };
}

function report(deviceId: string, ...tips: BoardTip[]): TipReport {
  return { deviceId, tips };
}

// ============================================================
// Cluster
// ============================================================

describe('filterKnownTips', () => {
  it('drops a re-sighting of a dart this camera already saw', () => {
    const tracked = [{ ...point(T20, 'cam-a'), observations: [point(T20, 'cam-a')] }];
    const { survivors } = filterKnownTips([point(nudged(T20, 1_000), 'cam-a')], tracked);
    expect(survivors).toHaveLength(0);
  });

  it('keeps a genuinely new dart even when it lands close to a tracked one', () => {
    const tracked = [{ ...point(T20, 'cam-a'), observations: [point(T20, 'cam-a')] }];
    // Beyond the repeat radius but inside the merge radius: two tips this close from the SAME
    // camera cannot be one dart, because a tip is not that big.
    const apart = nudged(T20, REPEAT_FILTER_RADIUS + 100);
    const { survivors } = filterKnownTips([point(apart, 'cam-a')], tracked);
    expect(survivors).toHaveLength(1);
  });

  it('attaches a second camera seeing a known dart for the first time', () => {
    const tracked = [{ ...point(T20, 'cam-a'), observations: [point(T20, 'cam-a')] }];
    const { survivors, tracked: next } = filterKnownTips(
      [point(nudged(T20, 3_000), 'cam-b')],
      tracked,
    );
    expect(survivors).toHaveLength(0);
    expect(next[0].observations.map((o) => o.deviceId)).toEqual(['cam-a', 'cam-b']);
  });

  it('does not attach a second camera to a dart it is nowhere near', () => {
    const tracked = [{ ...point(T20, 'cam-a'), observations: [point(T20, 'cam-a')] }];
    const { survivors } = filterKnownTips([point(T19, 'cam-b')], tracked);
    expect(survivors).toHaveLength(1);
  });

  it('leaves the input untouched', () => {
    const tracked = [{ ...point(T20, 'cam-a'), observations: [point(T20, 'cam-a')] }];
    filterKnownTips([point(nudged(T20, 3_000), 'cam-b')], tracked);
    expect(tracked[0].observations).toHaveLength(1);
  });
});

describe('clusterNewTips', () => {
  it('merges two cameras seeing one dart into one candidate', () => {
    const candidates = clusterNewTips([
      point(T20, 'cam-a', 0.8),
      point(nudged(T20, 4_000), 'cam-b', 0.95),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].cameraCount).toBe(2);
    // The seed is the highest-confidence sighting, not an average nobody observed.
    expect(candidates[0].x).toBe(T20[0] + 4_000);
    expect(candidates[0].confidence).toBe(0.95);
  });

  it('keeps a tight three-dart group as three darts', () => {
    const candidates = clusterNewTips(T20_GROUP.map((p) => point(p, 'cam-a')));
    expect(candidates).toHaveLength(3);
  });

  it('merges tips closer together than a dart is wide', () => {
    const twiceSeen = [point(T20, 'cam-a'), point(nudged(T20, THROW_WINDOW_DART_RADIUS - 1), 'cam-b')];
    expect(clusterNewTips(twiceSeen)).toHaveLength(1);
  });

  it('ranks more cameras over higher confidence', () => {
    const agreed = clusterNewTips([point(T20, 'cam-a', 0.8), point(nudged(T20, 2_000), 'cam-b', 0.8)])[0];
    const lone = clusterNewTips([point(T19, 'cam-a', 0.99)])[0];
    expect([lone, agreed].sort(rankCandidates)[0]).toBe(agreed);
  });
});

// ============================================================
// Tracker
// ============================================================

describe('DartTracker', () => {
  it('scores a tip once it has been fused', () => {
    const darts = new DartTracker().ingest([report('cam-a', tip(T20))]);
    expect(darts).toHaveLength(1);
    expect(darts[0].score.label).toBe('T20');
    expect(darts[0].score.points).toBe(60);
  });

  it('two cameras seeing one dart produce one dart with one score', () => {
    const darts = new DartTracker().ingest([
      report('cam-a', tip(T20)),
      report('cam-b', tip(nudged(T20, 4_000), 0.95)),
    ]);
    expect(darts).toHaveLength(1);
    expect(darts[0].cameraCount).toBe(2);
    expect(darts[0].sightings).toBe(2);
    expect(darts[0].score.label).toBe('T20');
  });

  it('does not count a dart already in the board on the next window', () => {
    const tracker = new DartTracker();
    expect(tracker.ingest([report('cam-a', tip(T20))])).toHaveLength(1);
    expect(tracker.ingest([report('cam-a', tip(nudged(T20, 800)))])).toHaveLength(0);
    expect(tracker.count).toBe(1);
  });

  it('finds a dart only one camera can see', () => {
    const tracker = new DartTracker();
    // cam-b is occluded and reports only two of the three.
    const darts = tracker.ingest([
      report('cam-a', tip(T20), tip(T19), tip(S20)),
      report('cam-b', tip(nudged(T20, 3_000)), tip(nudged(T19, 3_000))),
    ]);
    expect(darts).toHaveLength(3);
    expect(darts.filter((d) => d.cameraCount === 2)).toHaveLength(2);
    expect(darts.filter((d) => d.cameraCount === 1)).toHaveLength(1);
  });

  it('attaches a late camera across windows instead of doubling the dart', () => {
    const tracker = new DartTracker();
    tracker.ingest([report('cam-a', tip(T20))]);
    expect(tracker.ingest([report('cam-b', tip(nudged(T20, 3_000)))])).toHaveLength(0);
    expect(tracker.count).toBe(1);
  });

  it('an empty report changes nothing', () => {
    const tracker = new DartTracker();
    tracker.ingest([report('cam-a', tip(T20))]);
    expect(tracker.ingest([report('cam-a')])).toHaveLength(0);
    expect(tracker.count).toBe(1);
  });

  it('forgets everything on reset', () => {
    const tracker = new DartTracker();
    tracker.ingest([report('cam-a', tip(T20))]);
    tracker.reset();
    expect(tracker.count).toBe(0);
    expect(tracker.ingest([report('cam-a', tip(T20))])).toHaveLength(1);
  });

  it('a grouped three-dart throw scores 180, not 60', () => {
    const darts = new DartTracker().ingest([report('cam-a', ...T20_GROUP.map((p) => tip(p)))]);
    expect(darts).toHaveLength(3);
    expect(darts.map((d) => d.score.label)).toEqual(['T20', 'T20', 'T20']);
    expect(darts.reduce((sum, d) => sum + d.score.points, 0)).toBe(180);
  });
});

// ============================================================
// Throw windows
// ============================================================

describe('ThrowWindows', () => {
  function harness(expected: () => number) {
    const closed: WindowResult[] = [];
    const windows = new ThrowWindows({ expectedCameras: expected, onClose: (r) => closed.push(r) });
    return { windows, closed };
  }

  it('closes synchronously with a single camera', () => {
    const { windows, closed } = harness(() => 1);
    windows.add(report('cam-a', tip(T20)));
    expect(closed).toHaveLength(1);
    expect(closed[0].reason).toBe('all-cameras');
    expect(closed[0].reports).toHaveLength(1);
  });

  it('waits for the second camera, then closes at once', () => {
    const { windows, closed } = harness(() => 2);
    windows.add(report('cam-a', tip(T20)));
    expect(closed).toHaveLength(0);
    windows.add(report('cam-b', tip(T20)));
    expect(closed).toHaveLength(1);
    expect(closed[0].reports).toHaveLength(2);
  });

  it('a camera reporting twice inside one window replaces itself', () => {
    const { windows, closed } = harness(() => 2);
    windows.add(report('cam-a', tip(T20)));
    windows.add(report('cam-a', tip(T19), tip(S20)));
    expect(closed).toHaveLength(0);
    windows.add(report('cam-b', tip(T20)));
    expect(closed[0].reports).toHaveLength(2);
    expect(closed[0].reports.find((r) => r.deviceId === 'cam-a')!.tips).toHaveLength(2);
  });

  it('a camera leaving releases a window that was waiting for it', () => {
    let expected = 2;
    const { windows, closed } = harness(() => expected);
    windows.add(report('cam-a', tip(T20)));
    expect(closed).toHaveLength(0);
    expected = 1;
    windows.recount();
    expect(closed).toHaveLength(1);
    expect(closed[0].reason).toBe('all-cameras');
  });

  it('falls back to the cap when it has no latency history', async () => {
    const { windows, closed } = harness(() => 2);
    windows.add(report('cam-a', tip(T20)));
    await new Promise((r) => setTimeout(r, THROW_WINDOW_MAX_MS + 60));
    expect(closed).toHaveLength(1);
    expect(closed[0].reason).toBe('max-window');
    expect(closed[0].reports).toHaveLength(1);
  });

  it('adapts the timeout down once it has seen how late the second camera is', async () => {
    const { windows, closed } = harness(() => 2);
    // Ten windows where cam-b arrives a consistent 20ms after cam-a. That is what teaches the
    // estimator a p75; cameras arriving in the same tick teach it nothing, and it correctly falls
    // back to the cap in that case.
    for (let i = 0; i < 10; i++) {
      windows.add(report('cam-a', tip(T20)));
      await new Promise((r) => setTimeout(r, 20));
      windows.add(report('cam-b', tip(T20)));
    }
    expect(closed).toHaveLength(10);

    // Now cam-b never arrives: the window must give up well inside the cap.
    const started = Date.now();
    windows.add(report('cam-a', tip(T20)));
    await new Promise((r) => setTimeout(r, 400));
    expect(closed).toHaveLength(11);
    expect(closed[10].reason).toBe('adaptive-timeout');
    expect(Date.now() - started).toBeLessThan(THROW_WINDOW_MAX_MS);
  });

  it('stop() abandons an open window without closing it', async () => {
    const { windows, closed } = harness(() => 2);
    windows.add(report('cam-a', tip(T20)));
    windows.stop();
    await new Promise((r) => setTimeout(r, THROW_WINDOW_MAX_MS + 60));
    expect(closed).toHaveLength(0);
  });
});
