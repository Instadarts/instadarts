// The one place that knows what a scannable pairing link looks like.
//
// Both ends of the QR live here: the gaming frontend builds the url that goes into the symbol, and
// the scoring device reads the code back out of the url it was opened with. Keeping them in one
// module is the point — a query parameter renamed on one side and not the other is a QR that
// silently does nothing, and nothing else in the app would notice.

/** The query parameter carrying a pairing code. */
const CODE_PARAM = 'code';

/** Six characters, from the unambiguous alphabet `server/devices.ts` mints them out of. */
const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

/**
 * Where a phone should go to pair with this frontend, carrying the code.
 *
 * Built from `window.location.origin`, which is the only address known to work: it is the one this
 * browser actually reached the server on, so it is right behind a reverse proxy, right on a bare
 * IP, and right on a LAN — and needs no deployment setting to say so. The server has no idea what
 * address it is being reached at, and does not need one.
 */
export function pairingUrl(code: string): string {
  return `${window.location.origin}/scorer?${CODE_PARAM}=${encodeURIComponent(code)}`;
}

/**
 * The pairing code this page was opened with, if it was opened with a valid-looking one.
 *
 * Shape-checked here so that a mistyped or truncated link fails as "no code" — leaving the phone on
 * the ordinary pairing screen — rather than as a redemption the server refuses, which would show
 * somebody who scanned a QR an error about a code they never saw.
 *
 * Uppercased first: some scanners hand back a lowercased url, and the alphabet is upper case.
 */
export function readPairingCode(search: string = window.location.search): string | null {
  const raw = new URLSearchParams(search).get(CODE_PARAM)?.toUpperCase() ?? null;
  return raw && CODE_PATTERN.test(raw) ? raw : null;
}

/**
 * Take the code back out of the address bar, keeping everything else.
 *
 * A pairing code is single-use, so leaving it in the url means a reload — or a phone restoring its
 * tabs tomorrow morning — trying to redeem a code that is long gone, and being told it is invalid.
 * `replaceState` rather than `pushState`: the address with the code in it should not become
 * somewhere the back button can return to.
 */
export function clearPairingCode(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(CODE_PARAM)) return;
  url.searchParams.delete(CODE_PARAM);
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
