// The one seam the end-to-end suite is allowed to reach through, and the one guard that keeps it
// shut everywhere else.
//
// Some of what this app does is measured in minutes — a camera that switches itself off, a device
// that goes to sleep — and a test cannot wait for those. It also cannot fake them, because faking
// them would test a stub. So the durations are overridable, and the override is bolted to a build
// flag: `?e2e=1` does nothing at all in a production bundle.

const E2E_SESSION_KEY = 'instadarts_e2e';

/**
 * True only in a build that was made for tests. Once a URL asks, retain that answer for this tab so
 * navigation and a page reload do not remove the very recovery controls the suite is exercising.
 */
export function e2eEnabled(): boolean {
  if (!import.meta.env.DEV && !import.meta.env.VITE_E2E) return false;
  if (new URLSearchParams(window.location.search).get('e2e') === '1') {
    sessionStorage.setItem(E2E_SESSION_KEY, '1');
    return true;
  }
  return sessionStorage.getItem(E2E_SESSION_KEY) === '1';
}

/**
 * A number from the query string, for a build that is allowed to have one.
 *
 * Returns null for anything missing, unparseable or negative, so a caller's `?? realValue` is always
 * the real value unless a test deliberately said otherwise.
 */
export function e2eNumber(param: string): number | null {
  if (!e2eEnabled()) return null;
  const raw = new URLSearchParams(window.location.search).get(param);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
