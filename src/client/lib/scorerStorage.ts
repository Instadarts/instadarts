// The scoring device's own identity, and its own settings.
//
// Deliberately different keys from the gaming frontend's (lib/deviceStorage.ts), so both apps can
// run in one browser without either overwriting the other. A device stores its token; a frontend
// stores only a hash of it. Neither ever holds the other's secret.

const DEVICE_KEY = 'instadarts_scorer_device';
const SETTINGS_KEY = 'instadarts_scorer_settings';

export interface ScorerIdentity {
  deviceId: string;
  token: string;
  name: string;
}

export interface ScorerSettings {
  model: string;
  boardThreshold: number;
  tipThreshold: number;
  /** Slider position (-100…100), per camera *label* — the value describes a lens, not a device. */
  lensByCamera: Record<string, number>;
  screensaver: boolean;
}

// The remembered camera and its zoom are NOT here: they live in vision/camera.js, which is the
// module that knows a camera by its label and applies the zoom to the track.

const SETTINGS_DEFAULTS: ScorerSettings = {
  model: 's_960',
  boardThreshold: 0.8,
  tipThreshold: 0.75,
  lensByCamera: {},
  screensaver: true,
};

export function loadIdentity(): ScorerIdentity | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.deviceId !== 'string' || typeof parsed?.token !== 'string') return null;
    return { deviceId: parsed.deviceId, token: parsed.token, name: parsed.name ?? '' };
  } catch {
    // Corrupt storage is not worth failing the boot over — pair again.
    return null;
  }
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
    };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
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
