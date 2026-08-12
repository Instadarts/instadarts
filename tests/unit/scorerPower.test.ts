import { describe, it, expect, beforeEach } from 'vitest';
import {
  clampMinutes,
  GRACE_MINUTES,
  nextStage,
  STANDBY_MINUTES,
  type PowerInput,
  type PowerStage,
} from '../../src/client/lib/scorerPower';
import { loadSettings, saveSettings } from '../../src/client/lib/scorerStorage';
import { classifyScoringActivation } from '../../src/client/lib/scorerReconnect';

/**
 * When a scoring device turns things off.
 *
 * The rules are two timers, and the thing worth testing is that all the behaviour claimed to fall
 * out of them actually does — a match ending giving a re-match its grace, an unclaimed device and a
 * disconnected one needing no rules of their own, and aiming the camera not being interrupted. Each
 * of those is a case here rather than a line of code, which is the point of the design.
 */

const MINUTE = 60_000;

/**
 * The suite runs in node, and the settings live in localStorage. Enough of one to read and write a
 * string — everything else about a real Storage is beside the point here.
 */
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
});

beforeEach(() => store.clear());

describe('scoring state across connections', () => {
  it('recognises the same context on a replacement socket as a resume', () => {
    expect(classifyScoringActivation('match-a::player-a', 'match-a::player-a', true)).toBe('resumed');
  });

  it('recognises a different context or a live inactive-to-active transition as a start', () => {
    expect(classifyScoringActivation('match-a::player-a', 'match-b::player-a', true)).toBe('started');
    expect(classifyScoringActivation(null, 'match-a::player-a', false)).toBe('started');
  });

  it('ignores inactive and duplicate live states', () => {
    expect(classifyScoringActivation('match-a::player-a', null, true)).toBeNull();
    expect(classifyScoringActivation('match-a::player-a', 'match-a::player-a', false)).toBeNull();
  });
});

function at(over: Partial<PowerInput> = {}): PowerStage {
  return nextStage({
    scoring: false,
    idleMs: 0,
    notScoringMs: 0,
    cameraOffMs: 0,
    graceMs: 2 * MINUTE,
    standbyMs: 30 * MINUTE,
    ...over,
  });
}

describe('a device that is scoring', () => {
  it('powers nothing down, however long since anyone touched it', () => {
    // A leg can run for many minutes with nobody near the phone. That is not idleness.
    expect(at({ scoring: true, idleMs: 10 * MINUTE })).toBe('awake');
    expect(at({ scoring: true, idleMs: 10 * 60 * MINUTE, cameraOffMs: 10 * 60 * MINUTE })).toBe('awake');
  });

  it('comes back the moment a match starts, from either stage', () => {
    expect(at({ scoring: true, idleMs: 5 * MINUTE, notScoringMs: 5 * MINUTE })).toBe('awake');
    expect(at({ scoring: true, idleMs: 90 * MINUTE, cameraOffMs: 90 * MINUTE })).toBe('awake');
  });
});

describe('the short timer', () => {
  it('stops the camera once the grace period passes with no match', () => {
    expect(at({ idleMs: 2 * MINUTE - 1, notScoringMs: 2 * MINUTE - 1 })).toBe('awake');
    expect(at({ idleMs: 2 * MINUTE, notScoringMs: 2 * MINUTE })).toBe('camera-off');
  });

  it('gives a re-match its grace after a long match nobody touched', () => {
    // The bug this rules out: measuring from the last touch alone would stop the camera the instant
    // a quiet match ended, with the players still standing at the board.
    expect(at({ idleMs: 40 * MINUTE, notScoringMs: 5_000 })).toBe('awake');
    expect(at({ idleMs: 40 * MINUTE, notScoringMs: 2 * MINUTE })).toBe('camera-off');
  });

  it('needs no rule of its own for being unclaimed or disconnected', () => {
    // Both are simply "not scoring": the device cannot be feeding a match either way.
    const unclaimedOrOffline = { idleMs: 3 * MINUTE, notScoringMs: 3 * MINUTE };
    expect(at(unclaimedOrOffline)).toBe('camera-off');
  });

  it('leaves the camera alone while somebody is aiming it', () => {
    // Framing the board and calibrating the lens are both a finger on the screen every few seconds,
    // which is exactly what keeps this from firing.
    expect(at({ idleMs: 20_000, notScoringMs: 60 * MINUTE })).toBe('awake');
  });
});

describe('the long timer', () => {
  it('sleeps only once the camera has been off for the full delay', () => {
    expect(at({ idleMs: 30 * MINUTE, cameraOffMs: 30 * MINUTE - 1, notScoringMs: 30 * MINUTE })).toBe('camera-off');
    expect(at({ idleMs: 30 * MINUTE, cameraOffMs: 30 * MINUTE, notScoringMs: 30 * MINUTE })).toBe('standby');
  });

  it('never sleeps while a camera is running', () => {
    // Held at zero while the camera is open, which is what "the long timer stops when the camera
    // runs" means in practice.
    expect(at({ idleMs: 90 * MINUTE, cameraOffMs: 0, notScoringMs: 90 * MINUTE })).toBe('camera-off');
  });

  it('counts a camera that was never started, so an untouched device still sleeps', () => {
    // Paired, claimed and forgotten about: nothing else in the model would ever switch this off.
    expect(at({ idleMs: 30 * MINUTE, cameraOffMs: 30 * MINUTE, notScoringMs: 30 * MINUTE })).toBe('standby');
  });

  it('is reset by a touch, like the short one', () => {
    expect(at({ idleMs: 1_000, cameraOffMs: 90 * MINUTE, notScoringMs: 90 * MINUTE })).toBe('awake');
  });
});

describe('the two together', () => {
  it('reach standby through camera-off and never around it', () => {
    // Walked minute by minute, which is the only way to show the order actually holds.
    const seen: PowerStage[] = [];
    let cameraOffSince: number | null = null;
    for (let minute = 0; minute <= 40; minute++) {
      const stage = nextStage({
        scoring: false,
        idleMs: minute * MINUTE,
        notScoringMs: minute * MINUTE,
        cameraOffMs: cameraOffSince === null ? 0 : (minute - cameraOffSince) * MINUTE,
        graceMs: 2 * MINUTE,
        standbyMs: 30 * MINUTE,
      });
      if (stage !== 'awake' && cameraOffSince === null) cameraOffSince = minute;
      seen.push(stage);
    }

    expect(seen[0]).toBe('awake');
    expect(seen[2]).toBe('camera-off');
    // The camera goes off at 2 minutes, so standby is 30 minutes after *that* — 32, not 30.
    expect(seen[31]).toBe('camera-off');
    expect(seen[32]).toBe('standby');
    expect(seen.indexOf('standby')).toBeGreaterThan(seen.indexOf('camera-off'));
  });

  it('skip the camera-off stage when both delays are set to the same number', () => {
    // Reachable only at the extremes of the two ranges. Harmless, and cheaper to allow than forbid.
    expect(GRACE_MINUTES.max).toBe(STANDBY_MINUTES.min);
    const both = 10 * MINUTE;
    expect(at({ idleMs: both, notScoringMs: both, cameraOffMs: both, graceMs: both, standbyMs: both }))
      .toBe('standby');
  });
});

describe('the delays a user can set', () => {
  it('hold their promise: long enough to set a device up, short enough to still be a limit', () => {
    expect(GRACE_MINUTES.min).toBeGreaterThan(0);
    expect(GRACE_MINUTES.default).toBeGreaterThanOrEqual(GRACE_MINUTES.min);
    expect(GRACE_MINUTES.default).toBeLessThanOrEqual(GRACE_MINUTES.max);
    expect(STANDBY_MINUTES.default).toBeGreaterThanOrEqual(STANDBY_MINUTES.min);
    expect(STANDBY_MINUTES.default).toBeLessThanOrEqual(STANDBY_MINUTES.max);
    // Sleeping before the camera stops would make the shorter stage unreachable.
    expect(STANDBY_MINUTES.min).toBeGreaterThanOrEqual(GRACE_MINUTES.max);
  });

  it('clamp anything out of range rather than taking it', () => {
    expect(clampMinutes(5, GRACE_MINUTES)).toBe(5);
    expect(clampMinutes(0, GRACE_MINUTES)).toBe(GRACE_MINUTES.min);
    expect(clampMinutes(-30, GRACE_MINUTES)).toBe(GRACE_MINUTES.min);
    expect(clampMinutes(9999, STANDBY_MINUTES)).toBe(STANDBY_MINUTES.max);
    expect(clampMinutes(2.6, STANDBY_MINUTES)).toBe(STANDBY_MINUTES.min);
  });

  it('fall back to the default for anything that is not a number', () => {
    for (const raw of [undefined, null, '20', NaN, Infinity, {}, []]) {
      expect(clampMinutes(raw, STANDBY_MINUTES), String(raw)).toBe(STANDBY_MINUTES.default);
    }
  });

  it('are clamped on the way out of storage, so an edited value cannot disable a limit', () => {
    // The safeguard that matters: a camera left running all night is what the ceiling is for.
    localStorage.setItem(
      'instadarts_scorer_settings',
      JSON.stringify({ cameraOffAfterMinutes: 0, standbyAfterMinutes: 100_000 }),
    );
    const settings = loadSettings();
    expect(settings.cameraOffAfterMinutes).toBe(GRACE_MINUTES.min);
    expect(settings.standbyAfterMinutes).toBe(STANDBY_MINUTES.max);
    localStorage.clear();
  });

  it('start at the defaults', () => {
    localStorage.clear();
    expect(loadSettings().cameraOffAfterMinutes).toBe(GRACE_MINUTES.default);
    expect(loadSettings().standbyAfterMinutes).toBe(STANDBY_MINUTES.default);

    saveSettings({ standbyAfterMinutes: 45 });
    expect(loadSettings().standbyAfterMinutes).toBe(45);
    localStorage.clear();
  });
});
