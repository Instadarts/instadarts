import { useEffect } from 'react';

/**
 * Hold the screen awake, which on a mounted phone is what keeps the camera alive: the OS locking the
 * screen stops the camera with it.
 *
 * It used to live inside the screensaver and follow that setting, which meant a phone paired at six
 * in the evening held the screen on until the battery went flat — a display preference keeping a
 * power lock it had nothing to do with. The lock now belongs to the power stage
 * ([lib/scorerPower.ts](../lib/scorerPower.ts)) and is released when the device gives up waiting.
 *
 * Releasing it does not turn the screen off; it lets the OS do so on its own schedule. That is the
 * one-way part — nothing here can ever bring a sleeping phone back.
 */
export function useScreenWakeLock(hold: boolean): void {
  useEffect(() => {
    if (!hold) return;
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
  }, [hold]);
}
