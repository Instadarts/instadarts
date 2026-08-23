export const FRONTEND_ZOOM_STORAGE_KEY = 'instadarts_frontend_zoom_v1';
export const DEFAULT_FRONTEND_ZOOM = 100;
export const MIN_FRONTEND_ZOOM = 50;
export const MAX_FRONTEND_ZOOM = 150;
export const FRONTEND_ZOOM_STEP = 5;

const CSS_VARIABLE = '--instadarts-frontend-zoom';

function validFrontendZoom(value: number): boolean {
  return Number.isInteger(value)
    && value >= MIN_FRONTEND_ZOOM
    && value <= MAX_FRONTEND_ZOOM
    && value % FRONTEND_ZOOM_STEP === 0;
}

export function parseFrontendZoom(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return validFrontendZoom(value) ? value : null;
}

export function loadFrontendZoom(): number {
  try {
    return parseFrontendZoom(localStorage.getItem(FRONTEND_ZOOM_STORAGE_KEY)) ?? DEFAULT_FRONTEND_ZOOM;
  } catch {
    return DEFAULT_FRONTEND_ZOOM;
  }
}

function normalizeFrontendZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FRONTEND_ZOOM;
  const stepped = Math.round(value / FRONTEND_ZOOM_STEP) * FRONTEND_ZOOM_STEP;
  return Math.min(MAX_FRONTEND_ZOOM, Math.max(MIN_FRONTEND_ZOOM, stepped));
}

/** Persist one frontend-wide value; storage failure still leaves the caller's in-memory value usable. */
export function saveFrontendZoom(value: number): number {
  const normalized = normalizeFrontendZoom(value);
  try {
    localStorage.setItem(FRONTEND_ZOOM_STORAGE_KEY, String(normalized));
  } catch {
    // Private mode or blocked storage: keep the setting for this page lifetime only.
  }
  return normalized;
}

export function applyFrontendZoom(value: number): number {
  const normalized = normalizeFrontendZoom(value);
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty(CSS_VARIABLE, `${normalized}%`);
  }
  return normalized;
}
