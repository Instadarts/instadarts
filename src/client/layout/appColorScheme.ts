import type { MantineColorScheme, MantineColorSchemeManager } from '@mantine/core';
import type { AppZoomTarget } from './appZoom';

/**
 * Bright or dark, remembered per application.
 *
 * The same shape as `appZoom.ts`, and for the same reason: the gaming frontend and the scoring
 * device are two applications served from one origin, and what suits one is often wrong for the
 * other. A phone propped at the board wants to stay dark while the television across the room is
 * bright, so each keeps its own key rather than sharing Mantine's single default one.
 *
 * Storage access is guarded throughout. A blocked or private store gives the default on the next
 * page load, but must never stop the control working for this page's lifetime.
 */
export type AppColorSchemeTarget = AppZoomTarget;

/** Dark is what this application has always been; bright is opt-in, and never arrives by upgrade. */
export const DEFAULT_APP_COLOR_SCHEME: MantineColorScheme = 'dark';

export const APP_COLOR_SCHEME_STORAGE_KEYS: Record<AppColorSchemeTarget, string> = {
  frontend: 'instadarts_frontend_color_scheme_v1',
  scorer: 'instadarts_scorer_color_scheme_v1',
};

export function parseAppColorScheme(raw: string | null): MantineColorScheme | null {
  return raw === 'light' || raw === 'dark' ? raw : null;
}

export function loadAppColorScheme(target: AppColorSchemeTarget): MantineColorScheme {
  try {
    return parseAppColorScheme(localStorage.getItem(APP_COLOR_SCHEME_STORAGE_KEYS[target]))
      ?? DEFAULT_APP_COLOR_SCHEME;
  } catch {
    return DEFAULT_APP_COLOR_SCHEME;
  }
}

/** Persist one value per application; storage failure still leaves the in-memory scheme usable. */
export function saveAppColorScheme(
  target: AppColorSchemeTarget,
  value: MantineColorScheme,
): MantineColorScheme {
  const scheme = parseAppColorScheme(value) ?? DEFAULT_APP_COLOR_SCHEME;
  try {
    localStorage.setItem(APP_COLOR_SCHEME_STORAGE_KEYS[target], scheme);
  } catch {
    // Private mode or blocked storage: keep the setting for this page lifetime only.
  }
  return scheme;
}

/**
 * The storage half of `MantineProvider`, pointed at this application's key.
 *
 * Mantine's stock manager keeps one value for the whole origin, which would make the scoring device
 * follow whatever the last frontend tab chose. `subscribe` is where a manager would watch for the
 * value changing underneath it; nothing else in this application writes these keys, and a second
 * tab of the *same* application adopting the change on its next load is the behavior we want, so
 * there is nothing to listen to.
 */
export function appColorSchemeManager(target: AppColorSchemeTarget): MantineColorSchemeManager {
  return {
    get: (defaultValue) => {
      try {
        return parseAppColorScheme(localStorage.getItem(APP_COLOR_SCHEME_STORAGE_KEYS[target]))
          ?? defaultValue;
      } catch {
        return defaultValue;
      }
    },
    set: (value) => {
      saveAppColorScheme(target, value);
    },
    subscribe: () => {},
    unsubscribe: () => {},
    clear: () => {
      try {
        localStorage.removeItem(APP_COLOR_SCHEME_STORAGE_KEYS[target]);
      } catch {
        // Nothing was stored, so nothing has to be removed.
      }
    },
  };
}
