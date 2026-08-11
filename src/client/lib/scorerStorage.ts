// The scoring device's own identity, and its own settings.
//
// Deliberately different keys from the gaming frontend's (lib/deviceStorage.ts), so both apps can
// run in one browser without either overwriting the other. A device stores its token; a frontend
// stores only a hash of it. Neither ever holds the other's secret.

import type { MediaTier } from '../../shared/media';
import { DEFAULT_BOARD_THRESHOLD, DEFAULT_TIP_THRESHOLD } from '../../shared/vision/constants';
import { clampMinutes, GRACE_MINUTES, STANDBY_MINUTES } from './scorerPower';

const DEVICE_KEY = 'instadarts_scorer_device';
const SETTINGS_KEY = 'instadarts_scorer_settings';

/**
 * What this device is to the server. Deliberately just the credentials — see `deviceName`, which
 * used to live here and was destroyed every time somebody unpaired.
 */
export interface ScorerIdentity {
  deviceId: string;
  token: string;
}

export interface ScorerSettings {
  model: string;
  boardThreshold: number;
  tipThreshold: number;
  /** Slider position (-100…100), per camera *label* — the value describes a lens, not a device. */
  lensByCamera: Record<string, number>;
  screensaver: boolean;
  /**
   * What this device calls itself.
   *
   * A setting rather than part of the identity, for the same reason the lens calibration and the
   * zoom are: it describes this phone on this mount, which is exactly what does *not* change when
   * it is paired to somebody else.
   */
  deviceName: string;
  /** Idle minutes before the camera and motion detector stop. See lib/scorerPower.ts. */
  cameraOffAfterMinutes: number;
  /** Idle minutes before the wake lock is released and the socket closed. */
  standbyAfterMinutes: number;
  /**
   * How much of its view this phone is willing to let the people in the match see.
   *
   * A property of the phone rather than of the pairing, like the name and the lens calibration: a
   * camera pointed somewhere its owner would rather not broadcast is still pointed there after it
   * is handed to somebody else — and neither the owner nor the opponent can change this from their
   * end.
   *
   * It says what this device *offers*, never that it is in use. Being watched needs the owner to
   * nominate this device as their board camera as well; see shared/media.ts.
   */
  media: MediaTier;
  /** Whether to render the motion-tile overlay on the camera preview. */
  motionAnimations: boolean;
}

// The remembered camera and its zoom are NOT here: they live in vision/camera.js, which is the
// module that knows a camera by its label and applies the zoom to the track.

// The two confidence thresholds start at the tuned values from the vision constants rather than at
// numbers copied out of them: they are the reference pipeline's, marked there as not to be
// re-tuned, and a second copy here is a second thing to forget.
const SETTINGS_DEFAULTS: ScorerSettings = {
  model: 's_960',
  boardThreshold: DEFAULT_BOARD_THRESHOLD,
  tipThreshold: DEFAULT_TIP_THRESHOLD,
  lensByCamera: {},
  screensaver: true,
  deviceName: '',
  cameraOffAfterMinutes: GRACE_MINUTES.default,
  standbyAfterMinutes: STANDBY_MINUTES.default,
  media: 'video',
  motionAnimations: true,
};

export function loadIdentity(): ScorerIdentity | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.deviceId !== 'string' || typeof parsed?.token !== 'string') return null;
    return { deviceId: parsed.deviceId, token: parsed.token };
  } catch {
    // Corrupt storage is not worth failing the boot over — pair again.
    return null;
  }
}

/**
 * What this device calls itself, surviving anything that happens to the pairing.
 *
 * Names used to be stored inside the identity, so unpairing — which throws the identity away —
 * threw the name away with it, and a phone somebody had labelled "Board camera" came back nameless.
 * A name left over from a build that did that is carried across here, once.
 */
export function loadDeviceName(): string {
  const stored = loadSettings().deviceName;
  if (stored) return stored;

  try {
    const legacy = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? 'null')?.name;
    if (typeof legacy === 'string' && legacy) {
      saveSettings({ deviceName: legacy });
      return legacy;
    }
  } catch {
    // Nothing to carry across.
  }
  return '';
}

export function saveDeviceName(name: string): void {
  saveSettings({ deviceName: name });
}

export function saveIdentity(identity: ScorerIdentity): void {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(identity));
  } catch {
    // Private mode: this device works for the session and pairs again next time.
  }
}

/** Used when the server says it does not know us. Terminal for that identity. */
export function forgetIdentity(): void {
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    // ignore
  }
}

export function loadSettings(): ScorerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...SETTINGS_DEFAULTS };
    const stored = JSON.parse(raw) as Partial<ScorerSettings>;
    return {
      ...SETTINGS_DEFAULTS,
      ...stored,
      lensByCamera: { ...stored.lensByCamera },
      // Clamped on the way out rather than on the way in, so a value hand-edited into storage — or
      // left behind by an older build — cannot switch off a limit that exists to protect a battery.
      cameraOffAfterMinutes: clampMinutes(stored.cameraOffAfterMinutes, GRACE_MINUTES),
      standbyAfterMinutes: clampMinutes(stored.standbyAfterMinutes, STANDBY_MINUTES),
      media: asTier(stored.media),
    };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

/**
 * Read on the way out rather than trusted, like the two minute counts above.
 *
 * This setting was a boolean before it had three answers, so a phone that has been running the app
 * for a while has a `true` in storage where a tier belongs. Anything unrecognised — including that
 * `true` — becomes the default rather than a value nothing downstream can read.
 */
function asTier(raw: unknown): MediaTier {
  if (raw === 'disabled' || raw === 'stills' || raw === 'video') return raw;
  return raw === false ? 'disabled' : SETTINGS_DEFAULTS.media;
}

export function saveSettings(patch: Partial<ScorerSettings>): ScorerSettings {
  const next = { ...loadSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function lensForCamera(settings: ScorerSettings, cameraLabel: string): number {
  return settings.lensByCamera[cameraLabel] ?? 0;
}

export function setLensForCamera(cameraLabel: string, value: number): ScorerSettings {
  const settings = loadSettings();
  return saveSettings({ lensByCamera: { ...settings.lensByCamera, [cameraLabel]: value } });
}
