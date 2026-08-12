import { useCallback, useEffect, useRef, useState } from 'react';
import { nextStage, type PowerStage } from '../lib/scorerPower';
import type { ScoringActivation } from '../lib/scorerReconnect';
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
  /** A fresh scoring context, classified against the state before any reconnect. */
  activation: ScoringActivation | null;
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
 * It only ever powers things *down* on its timers. Coming back is a new scoring context, a resumed
 * context whose camera this hook stopped, or a person pressing something. The explicit activation
 * event is what keeps reconnecting from looking like a match start and undoing a manual camera-off.
 */
export function useScorerPower({
  scoring,
  activation,
  cameraActive,
  graceMs,
  standbyMs,
  stopCamera,
  startCamera,
}: Options) {
  const [stage, setStage] = useState<PowerStage>('awake');

  const lastActivity = useRef(Date.now());
  /** Null while the condition does not apply, so a clock is either running or it is not. */
  const notScoringSince = useRef<number | null>(Date.now());
  const cameraOffSince = useRef<number | null>(Date.now());

  const stageRef = useRef(stage);
  stageRef.current = stage;
  const scoringRef = useRef(scoring);
  scoringRef.current = scoring;
  const cameraActiveRef = useRef(cameraActive);
  cameraActiveRef.current = cameraActive;
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
  /** True only when this hook stopped a running camera because its timer expired. */
  const automaticallyStoppedCamera = useRef(false);

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
    automaticallyStoppedCamera.current = false;
    setStage('standby');
  }, []);

  useEffect(() => {
    for (const event of ['pointerdown', 'keydown'] as const) window.addEventListener(event, noteActivity);
    return () => {
      for (const event of ['pointerdown', 'keydown'] as const) window.removeEventListener(event, noteActivity);
    };
  }, [noteActivity]);

  // Operational scoring is false while disconnected, so this clock starts at the loss of the
  // socket and stops only after scorer_hello has produced a fresh active state.
  useEffect(() => {
    notScoringSince.current = scoring ? null : (notScoringSince.current ?? Date.now());
  }, [scoring]);

  // A new scoring context always starts the camera. A reconnect to the same context starts it only
  // if this hook stopped it during the outage; a camera its owner switched off remains off.
  const handledActivation = useRef(0);
  useEffect(() => {
    if (!activation || activation.seq === handledActivation.current) return;
    handledActivation.current = activation.seq;
    setStage('awake');
    if (activation.kind === 'started' || automaticallyStoppedCamera.current) {
      automaticallyStoppedCamera.current = false;
      startRef.current();
    }
  }, [activation]);

  useEffect(() => {
    cameraOffSince.current = cameraActive ? null : (cameraOffSince.current ?? Date.now());
    if (cameraActive) automaticallyStoppedCamera.current = false;
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
      if (next !== stageRef.current) {
        if (next !== 'awake' && cameraActiveRef.current) {
          automaticallyStoppedCamera.current = true;
        }
        setStage(next);
      }
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
