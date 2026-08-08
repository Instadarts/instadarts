import { useCallback, useEffect, useRef, useState } from 'react';
import { nextStage, type PowerStage } from '../lib/scorerPower';
import { useScreenWakeLock } from './useScreenWakeLock';

/** The same one-second beat the screensaver runs on. Neither timer is worth more resolution. */
const TICK_MS = 1000;
const MIN_TICK_MS = 100;

/** Fine enough to land inside whichever delay is shortest, which for the e2e suite is seconds. */
function tickFor(graceMs: number): number {
  return Math.max(MIN_TICK_MS, Math.min(TICK_MS, Math.floor(graceMs / 4)));
}

interface Options {
  /** A match is running that this device feeds. From `scorer_state`. */
  scoring: boolean;
  cameraActive: boolean;
  /** In milliseconds, not minutes: the e2e suite drives these far below what a user can set. */
  graceMs: number;
  standbyMs: number;
  /** Stop the camera and the motion detector. Always succeeds. */
  stopCamera: () => void;
  /** Open the last-used camera. May fail — a phone's browser has the final say. */
  startCamera: () => void;
}

/**
 * The scoring device's own power management: the two timers in
 * [lib/scorerPower.ts](../lib/scorerPower.ts), turned into the things they actually switch off.
 *
 * It only ever powers things *down*. Coming back is either a match starting — which includes this
 * device being claimed into one already running — or a person pressing something. That split is
 * deliberate twice over: a touch resets the timers, so a stage that also started cameras would
 * turn the camera back on the instant somebody pressed "Off"; and the camera is started on the
 * *edge* of a match beginning rather than whenever a match is on, so pressing "Off" mid-match
 * sticks, which is what "match events do not enforce anything during a match" means.
 */
export function useScorerPower({ scoring, cameraActive, graceMs, standbyMs, stopCamera, startCamera }: Options) {
  const [stage, setStage] = useState<PowerStage>('awake');

  const lastActivity = useRef(Date.now());
  /** Null while the condition does not apply, so a clock is either running or it is not. */
  const notScoringSince = useRef<number | null>(Date.now());
  const cameraOffSince = useRef<number | null>(Date.now());

  const stageRef = useRef(stage);
  stageRef.current = stage;
  const scoringRef = useRef(scoring);
  const stopRef = useRef(stopCamera);
  stopRef.current = stopCamera;
  const startRef = useRef(startCamera);
  startRef.current = startCamera;

  /**
   * Sent to standby by its owner rather than by a clock. Sticky, because the clocks disagree — the
   * timers have not run out, and without this the next tick would wake the device straight back up.
   * Only a person clears it.
   */
  const forcedStandby = useRef(false);

  /** A touch, a key, or a command from the frontend. Resets both timers. */
  const noteActivity = useCallback(() => {
    lastActivity.current = Date.now();
    forcedStandby.current = false;
    // Whatever this device had powered down, somebody is here now.
    if (stageRef.current !== 'awake') setStage('awake');
  }, []);

  /** The owner pressing power off. One-way from here: nothing but a touch on the phone comes back. */
  const powerOff = useCallback(() => {
    forcedStandby.current = true;
    setStage('standby');
  }, []);

  useEffect(() => {
    for (const event of ['pointerdown', 'keydown'] as const) window.addEventListener(event, noteActivity);
    return () => {
      for (const event of ['pointerdown', 'keydown'] as const) window.removeEventListener(event, noteActivity);
    };
  }, [noteActivity]);

  // A match beginning is the one thing that starts a camera without a person. On the edge only:
  // while a match runs, whether the camera is on is the user's business.
  useEffect(() => {
    const began = scoring && !scoringRef.current;
    scoringRef.current = scoring;
    notScoringSince.current = scoring ? null : (notScoringSince.current ?? Date.now());
    if (began) {
      setStage('awake');
      startRef.current();
    }
  }, [scoring]);

  useEffect(() => {
    cameraOffSince.current = cameraActive ? null : (cameraOffSince.current ?? Date.now());
  }, [cameraActive]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (forcedStandby.current) return;
      const now = Date.now();
      const since = (mark: number | null) => (mark === null ? 0 : now - mark);
      const next = nextStage({
        scoring: scoringRef.current,
        idleMs: now - lastActivity.current,
        notScoringMs: since(notScoringSince.current),
        cameraOffMs: since(cameraOffSince.current),
        graceMs,
        standbyMs,
      });
      if (next !== stageRef.current) setStage(next);
    }, tickFor(graceMs));
    return () => clearInterval(timer);
  }, [graceMs, standbyMs]);

  // What a stage means, in one place. Standby implies camera-off, so the camera is stopped for both
  // rather than only on the way past — a device that reached standby some other way is still off.
  useEffect(() => {
    if (stage !== 'awake') stopRef.current();
  }, [stage]);

  // Released only in standby. This is the one-way part: the OS may then sleep the phone, and
  // nothing here can wake it.
  useScreenWakeLock(stage !== 'standby');

  return {
    stage,
    /** In standby the socket is closed and stays closed — see useWebSocket's `standby`. */
    standby: stage === 'standby',
    noteActivity,
    powerOff,
  };
}
