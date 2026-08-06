import { useEffect, useRef, useState } from 'react';
import type { ScorerStateMessage } from '../../../shared/protocol';

/** The reference's numbers, field-worn, and there is no reason to differ. */
const IDLE_MS = 30_000;
const DRIFT_MS = 10_000;

interface ScreensaverProps {
  enabled: boolean;
  /** Suppressed while the lens is being calibrated: a screen that keeps blacking out is unusable. */
  suppressed: boolean;
  state: ScorerStateMessage | null;
}

/**
 * A phone sits mounted for a whole evening, so after half a minute of nothing the screen blacks out
 * and a small panel drifts around it, which is what stops an OLED holding one image long enough to
 * burn in.
 *
 * Three things it deliberately does not do:
 *
 *   · **stop the camera.** This is a display state and nothing else — inference, motion gating and
 *     tips all carry on underneath, so a blacked-out phone is still scoring.
 *   · **cover a gesture.** The tap that wakes the screen must not also press whatever was under it,
 *     so the overlay stays up until the finger lifts.
 *   · **dim while somebody is setting the device up.** That is what `suppressed` is for.
 *
 * It also wakes on its own when the match moves, which is what a live connection buys over a
 * timer: the screen comes back because somebody threw, not because somebody remembered to touch it.
 */
export function Screensaver({ enabled, suppressed, state }: ScreensaverProps) {
  const [asleep, setAsleep] = useState(false);
  const [drift, setDrift] = useState({ x: 30, y: 30 });
  const lastActivity = useRef(Date.now());

  const visit = state?.match?.visit.join(' ') ?? '';

  // Any change in the match is activity, exactly as a touch is.
  useEffect(() => {
    lastActivity.current = Date.now();
    setAsleep(false);
  }, [visit, state?.status]);

  useEffect(() => {
    if (!enabled || suppressed) {
      setAsleep(false);
      return;
    }
    const wake = () => {
      lastActivity.current = Date.now();
      setAsleep(false);
    };
    for (const event of ['pointerdown', 'keydown'] as const) window.addEventListener(event, wake);

    const timer = setInterval(() => {
      if (Date.now() - lastActivity.current >= IDLE_MS) setAsleep(true);
    }, 1000);

    return () => {
      for (const event of ['pointerdown', 'keydown'] as const) window.removeEventListener(event, wake);
      clearInterval(timer);
    };
  }, [enabled, suppressed]);

  useEffect(() => {
    if (!asleep) return;
    const timer = setInterval(() => {
      setDrift({ x: 10 + Math.random() * 70, y: 10 + Math.random() * 70 });
    }, DRIFT_MS);
    return () => clearInterval(timer);
  }, [asleep]);

  useScreenWakeLock(enabled);

  if (!asleep) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black"
      // pointerup, not pointerdown: the tap that wakes the screen must not also land on whatever
      // is underneath it.
      onPointerUp={() => setAsleep(false)}
    >
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-1000 text-center"
        style={{ left: `${drift.x}%`, top: `${drift.y}%` }}
      >
        {state?.match ? (
          <>
            <div className="flex gap-6">
              {state.match.players.map((player) => (
                <div key={player.name}>
                  <p className="text-xs text-gray-700">{player.name}</p>
                  <p className={`text-3xl font-mono ${player.active ? 'text-gray-400' : 'text-gray-700'}`}>
                    {player.remaining}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-2 font-mono text-gray-700">{visit}</p>
          </>
        ) : (
          <p className="text-gray-800">InstaDarts</p>
        )}
      </div>
    </div>
  );
}

/** Stop the OS locking the phone, which would kill the camera along with the screen. */
function useScreenWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    type Sentinel = { release: () => Promise<void> };
    const api = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } }).wakeLock;
    if (!api) return;

    let sentinel: Sentinel | null = null;
    let released = false;

    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      api.request('screen').then(
        (lock) => {
          if (released) void lock.release().catch(() => {});
          else sentinel = lock;
        },
        () => {},
      );
    };

    // The lock is dropped whenever the page is hidden, so it has to be taken again on return.
    acquire();
    document.addEventListener('visibilitychange', acquire);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', acquire);
      void sentinel?.release().catch(() => {});
    };
  }, [enabled]);
}
