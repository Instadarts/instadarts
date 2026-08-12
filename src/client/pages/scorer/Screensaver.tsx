import { useEffect, useRef, useState } from 'react';
import { e2eNumber } from '../../lib/e2e';

/** The reference's numbers, field-worn, and there is no reason to differ. */
const IDLE_MS = 30_000;
const DRIFT_MS = 10_000;

/**
 * How long to keep watching for the click a touch leaves behind.
 *
 * A touch that ends over an element fires `pointerup`, and then the browser synthesises a `click`
 * shortly afterwards, hit-testing wherever the finger was *at that moment*. By then this overlay is
 * gone, so without swallowing it the wake tap arrives at whatever button it was covering.
 */
const GHOST_CLICK_MS = 500;

interface ScreensaverProps {
  enabled: boolean;
  /** Suppressed while the lens is being calibrated: a screen that keeps blacking out is unusable. */
  suppressed: boolean;
}

/**
 * A phone sits mounted for a whole evening, so after half a minute of nothing the screen blacks out
 * and a small panel drifts around it, which is what stops an OLED holding one image long enough to
 * burn in.
 *
 * Three things it deliberately does not do:
 *
 *   · **stop the camera, or hold the screen awake.** This is a display state and nothing else —
 *     inference, motion gating and tips all carry on underneath, so a blacked-out phone is still
 *     scoring. Powering anything down belongs to [lib/scorerPower.ts](../../lib/scorerPower.ts),
 *     which owns the wake lock this file used to take.
 *   · **cover a gesture.** The tap that wakes the screen must not also press whatever was under it.
 *     The screen stops looking asleep the instant a finger lands, but the overlay itself stays up —
 *     invisible — until that finger lifts, and then swallows the click the touch leaves behind.
 *     Waking a phone should never score a dart.
 *   · **dim while somebody is setting the device up.** That is what `suppressed` is for.
 *
 * It only ever wakes on the phone itself: a key, or the lift of a finger that pressed it. Scoring
 * continues underneath the black screen, so a match has no reason to wake it.
 */
export function Screensaver({ enabled, suppressed }: ScreensaverProps) {
  const [asleep, setAsleep] = useState(false);
  /** A finger is down: the screen already looks awake, but the overlay is still catching the press. */
  const [revealed, setRevealed] = useState(false);
  const [drift, setDrift] = useState({ x: 30, y: 30 });
  const lastActivity = useRef(Date.now());

  useEffect(() => {
    if (!enabled || suppressed) {
      setAsleep(false);
      return;
    }
    const note = () => {
      lastActivity.current = Date.now();
    };
    /**
     * A key press has nothing to swallow, so it wakes the screen outright.
     *
     * A pointer press deliberately does **not**: it only pushes the deadline back, and the overlay
     * below decides when to go. Dismissing here instead — which is what this used to do — unmounted
     * the overlay while the finger was still down, so the press landed on whatever it was covering.
     */
    const wakeOnKey = () => {
      note();
      setAsleep(false);
    };
    window.addEventListener('pointerdown', note);
    window.addEventListener('keydown', wakeOnKey);

    // Half a minute is too long for a test to sit through, and the behaviour does not change with
    // the number. Does nothing in a shipped build — see lib/e2e.ts.
    const idleMs = e2eNumber('screensaverMs') ?? IDLE_MS;
    const timer = setInterval(() => {
      if (Date.now() - lastActivity.current >= idleMs) setAsleep(true);
    }, Math.min(1000, idleMs));

    return () => {
      window.removeEventListener('pointerdown', note);
      window.removeEventListener('keydown', wakeOnKey);
      clearInterval(timer);
    };
  }, [enabled, suppressed]);

  // Nothing is being caught while the screen is up.
  useEffect(() => {
    if (!asleep) setRevealed(false);
  }, [asleep]);

  const dismiss = () => {
    lastActivity.current = Date.now();
    setAsleep(false);
    swallowGhostClick();
  };

  useEffect(() => {
    if (!asleep) return;
    const timer = setInterval(() => {
      setDrift({ x: 10 + Math.random() * 70, y: 10 + Math.random() * 70 });
    }, DRIFT_MS);
    return () => clearInterval(timer);
  }, [asleep]);

  if (!asleep) return null;

  return (
    <div
      // Still covering the screen once revealed, and still opaque to pointers — it just stopped
      // being visible. That gap is the whole trick: the screen responds at once, and the press that
      // woke it has nowhere else to go.
      data-testid="screensaver"
      className={`fixed inset-0 z-50 ${revealed ? 'bg-transparent' : 'bg-black'}`}
      onPointerDown={() => setRevealed(true)}
      onPointerUp={dismiss}
      // A press that turns into a scroll or is taken over by the browser never gets its `pointerup`.
      onPointerCancel={dismiss}
    >
      {!revealed && (
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-1000 text-center"
          style={{ left: `${drift.x}%`, top: `${drift.y}%` }}
        >
          <p className="text-gray-800">InstaDarts</p>
        </div>
      )}
    </div>
  );
}

/**
 * Take the click a finished touch is about to leave behind, once.
 *
 * Capture phase, so it never reaches the button it was aimed at; and on a timer, because a mouse
 * release and a cancelled gesture produce no click at all and this must not lie in wait for the
 * next real one.
 */
function swallowGhostClick(): void {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    window.removeEventListener('click', swallow, true);
  };
  window.addEventListener('click', swallow, true);
  setTimeout(() => window.removeEventListener('click', swallow, true), GHOST_CLICK_MS);
}
