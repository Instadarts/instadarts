export type AppZoomTarget = 'frontend' | 'scorer';

export const DEFAULT_APP_ZOOM = 100;
export const MIN_APP_ZOOM = 50;
export const MAX_APP_ZOOM = 150;
export const APP_ZOOM_STEP = 5;

export const APP_ZOOM_STORAGE_KEYS: Record<AppZoomTarget, string> = {
  frontend: 'instadarts_frontend_zoom_v1',
  scorer: 'instadarts_scorer_zoom_v1',
};

const CSS_VARIABLES: Record<AppZoomTarget, string> = {
  frontend: '--instadarts-frontend-zoom',
  scorer: '--instadarts-scorer-zoom',
};

function validAppZoom(value: number): boolean {
  return Number.isInteger(value)
    && value >= MIN_APP_ZOOM
    && value <= MAX_APP_ZOOM
    && value % APP_ZOOM_STEP === 0;
}

export function parseAppZoom(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return validAppZoom(value) ? value : null;
}

export function loadAppZoom(target: AppZoomTarget): number {
  try {
    return parseAppZoom(localStorage.getItem(APP_ZOOM_STORAGE_KEYS[target])) ?? DEFAULT_APP_ZOOM;
  } catch {
    return DEFAULT_APP_ZOOM;
  }
}

function normalizeAppZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_APP_ZOOM;
  const stepped = Math.round(value / APP_ZOOM_STEP) * APP_ZOOM_STEP;
  return Math.min(MAX_APP_ZOOM, Math.max(MIN_APP_ZOOM, stepped));
}

/** Persist one value per application; storage failure still leaves in-memory zoom usable. */
export function saveAppZoom(target: AppZoomTarget, value: number): number {
  const normalized = normalizeAppZoom(value);
  try {
    localStorage.setItem(APP_ZOOM_STORAGE_KEYS[target], String(normalized));
  } catch {
    // Private mode or blocked storage: keep the setting for this page lifetime only.
  }
  return normalized;
}

export function applyAppZoom(target: AppZoomTarget, value: number): number {
  const normalized = normalizeAppZoom(value);
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty(CSS_VARIABLES[target], `${normalized}%`);
  }
  return normalized;
}
