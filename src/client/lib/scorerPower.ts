// When a scoring device turns things off.
//
// A phone mounted at a board is a phone nobody looks at, and left alone it will run its camera, its
// motion loop and its screen until the battery is flat. That is the whole problem this file exists
// for, and it solves it with two timers and no other state:
//
//   short timer   runs while   !scoring        fires → camera and motion detector off
//   long timer    runs while   !cameraActive   fires → wake lock released, socket closed
//
// Both reset on a touch, a key, or a command from the frontend.
//
// Everything the device does falls out of those two lines rather than being written anywhere:
//
//   · a match starting makes `scoring` true, which stops the short timer and starts the camera;
//   · a match ending starts it again, which is the grace period a re-match needs — and a re-match
//     inside that window stops it once more, so no "cancel the pending stop" rule is needed;
//   · being unclaimed and being disconnected are both simply *not scoring*, so neither needs a rule
//     of its own;
//   · aiming or calibrating keeps the camera alive, because both are a finger on the screen.
//     Walking away does not.
//
// Two consequences worth knowing, because neither is a bug:
//
//   · the long timer starts when the camera goes off, so with the defaults standby lands about 32
//     minutes after the last touch rather than 30;
//   · a camera that was never started counts as off, so a device paired, claimed and never touched
//     goes to standby half an hour later having done nothing at all. That is the point.
//
// One thing a stage deliberately does NOT do is start a camera. Stages only ever power things
// *down*; coming back is `scoring` going true, or somebody pressing a button. Otherwise the touch
// that resets these timers would fight the "Off" button that produced it.

/**
 * What the device has powered down so far.
 *
 * Strictly ordered — standby is only ever reached through `camera-off` — which is what lets the two
 * timers be read independently rather than as a machine to trace through.
 */
export type PowerStage = 'awake' | 'camera-off' | 'standby';

export interface PowerInput {
  /** A match is running that this device's tips would feed. Outranks both timers. */
  scoring: boolean;
  /** Since the last touch, key, or command from the frontend. Resets both timers. */
  idleMs: number;
  /** Since `scoring` was last true. Zero while scoring — this is the short timer's own clock. */
  notScoringMs: number;
  /** Since the camera was last open, or since start-up if it never has been. The long timer's. */
  cameraOffMs: number;
  graceMs: number;
  standbyMs: number;
}

export function nextStage(input: PowerInput): PowerStage {
  // A device feeding a live match powers nothing down, whatever the clocks say.
  if (input.scoring) return 'awake';

  // Each timer has been running since the later of its own trigger and the last touch.
  if (Math.min(input.idleMs, input.cameraOffMs) >= input.standbyMs) return 'standby';
  if (Math.min(input.idleMs, input.notScoringMs) >= input.graceMs) return 'camera-off';
  return 'awake';
}

// ============================================================
// The two durations, as the user sets them
// ============================================================

/**
 * Bounds rather than preferences.
 *
 * The floors keep a device from switching off while somebody is still setting it up; the ceilings
 * are the safeguard, because the usual reason to raise these is a phone on a charger and the usual
 * cost of forgetting one is a camera left running all night. Ten hours is long enough for any
 * evening and still a limit.
 */
export const GRACE_MINUTES = { min: 1, max: 10, default: 2 } as const;
export const STANDBY_MINUTES = { min: 10, max: 600, default: 30 } as const;

export interface MinuteBounds {
  min: number;
  max: number;
  default: number;
}

/** Stored settings are read through this, so a hand-edited value cannot disable a limit. */
export function clampMinutes(raw: unknown, bounds: MinuteBounds): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return bounds.default;
  return Math.min(Math.max(Math.round(raw), bounds.min), bounds.max);
}
