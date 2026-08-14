// Whether this browser takes part in media.
//
// Distinct from the deployment's own flag, and deliberately so: the server decides whether the
// feature exists, and this decides whether *this* browser wants it. Both have to say yes.
//
// Opting out is not a state the server holds — a client that has opted out simply never announces
// itself, so it appears in nobody's roster. That is why there is no "disabled" flag anywhere on the
// wire to keep in step with this one.
//
// localStorage rather than sessionStorage: this is a preference about the person, not about the tab,
// and somebody who turned video off does not want it back in the next window they open. The scoring
// device keeps its own answer under its own key (lib/scorerStorage.ts), so a phone and a frontend
// sharing a browser do not overwrite each other.

const MEDIA_KEY = 'instadarts_media';

/**
 * Default on, where the deployment allows it at all.
 *
 * A frontend has no camera of its own, but it commands its nominated scoring device and receives the
 * opponent's board. The switch exists for somebody who wants neither side of that exchange.
 */
export function loadMediaEnabled(): boolean {
  try {
    return localStorage.getItem(MEDIA_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveMediaEnabled(enabled: boolean): boolean {
  try {
    localStorage.setItem(MEDIA_KEY, enabled ? '1' : '0');
  } catch {
    // Private mode: the answer holds for this session and has to be given again next time.
  }
  return enabled;
}

// ============================================================
// The board camera
// ============================================================

const BOARD_CAMERA_KEY = 'instadarts_board_camera';

/**
 * Which of this tab's claimed devices is shared as its board, if any.
 *
 * **sessionStorage**, matching the grabs in deviceStorage.ts, because you can only nominate a device
 * this tab actually holds — a choice in one tab has no meaning in another that never claimed it.
 *
 * At most one, and `null` is a real answer rather than an absence: it is what the opponent sees,
 * too, so declining to nominate anything is a complete opt-out nobody can work around.
 */
export function loadBoardCamera(): string | null {
  try {
    return sessionStorage.getItem(BOARD_CAMERA_KEY);
  } catch {
    return null;
  }
}

export function saveBoardCamera(deviceId: string | null): string | null {
  try {
    if (deviceId === null) sessionStorage.removeItem(BOARD_CAMERA_KEY);
    else sessionStorage.setItem(BOARD_CAMERA_KEY, deviceId);
  } catch {
    // ignore
  }
  return deviceId;
}
