// The one seam the end-to-end suite is allowed to reach through, and the one guard that keeps it
// shut everywhere else.
//
// Some of what this app does is measured in minutes — a camera that switches itself off, a device
// that goes to sleep — and a test cannot wait for those. It also cannot fake them, because faking
// them would test a stub. So the durations are overridable, and the override is bolted to a build
// flag: `?e2e=1` does nothing at all in a production bundle.

/** True only in a build that was made for tests, and only when the URL asks. Never both by accident. */
export function e2eEnabled(): boolean {
  if (!import.meta.env.DEV && !import.meta.env.VITE_E2E) return false;
  return new URLSearchParams(window.location.search).get('e2e') === '1';
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
