import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_COLOR_SCHEME_STORAGE_KEYS,
  DEFAULT_APP_COLOR_SCHEME,
  appColorSchemeManager,
  loadAppColorScheme,
  parseAppColorScheme,
  saveAppColorScheme,
} from '../../src/client/layout/appColorScheme';
import { loadSettings, resetSettings, saveSettings } from '../../src/client/lib/scorerStorage';

let values: Record<string, string>;
let previousStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  values = {};
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => { values[key] = value; },
      removeItem: (key: string) => { delete values[key]; },
    },
  });
});

afterEach(() => {
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('application colour scheme', () => {
  it('accepts only the two schemes it can apply', () => {
    expect(parseAppColorScheme('light')).toBe('light');
    expect(parseAppColorScheme('dark')).toBe('dark');
    // `auto` is a scheme Mantine understands and this application does not offer.
    expect(parseAppColorScheme('auto')).toBeNull();
    expect(parseAppColorScheme('')).toBeNull();
    expect(parseAppColorScheme(null)).toBeNull();
  });

  it('loads a stored value and defaults malformed data to dark', () => {
    values[APP_COLOR_SCHEME_STORAGE_KEYS.frontend] = 'light';
    expect(loadAppColorScheme('frontend')).toBe('light');

    values[APP_COLOR_SCHEME_STORAGE_KEYS.frontend] = 'sepia';
    expect(loadAppColorScheme('frontend')).toBe(DEFAULT_APP_COLOR_SCHEME);
    expect(DEFAULT_APP_COLOR_SCHEME).toBe('dark');
  });

  it('keeps frontend and scorer preferences separate', () => {
    saveAppColorScheme('frontend', 'light');
    saveAppColorScheme('scorer', 'dark');

    expect(loadAppColorScheme('frontend')).toBe('light');
    expect(loadAppColorScheme('scorer')).toBe('dark');
    expect(values[APP_COLOR_SCHEME_STORAGE_KEYS.frontend]).toBe('light');
    expect(values[APP_COLOR_SCHEME_STORAGE_KEYS.scorer]).toBe('dark');
  });

  it('gives Mantine a manager over this application key alone', () => {
    const frontend = appColorSchemeManager('frontend');
    const scorer = appColorSchemeManager('scorer');

    expect(frontend.get('dark')).toBe('dark');
    frontend.set('light');
    expect(frontend.get('dark')).toBe('light');
    expect(scorer.get('dark')).toBe('dark');
    expect(values[APP_COLOR_SCHEME_STORAGE_KEYS.scorer]).toBeUndefined();

    frontend.clear();
    expect(frontend.get('dark')).toBe('dark');
  });

  it('survives resetting scorer setup because presentation is not a vision setting', () => {
    saveAppColorScheme('scorer', 'light');
    saveSettings({ model: 's_1280', didOnboard: true, deviceName: 'Board camera' });

    const reset = resetSettings();

    expect(reset).toEqual(loadSettings());
    expect(reset).toMatchObject({ model: 's_960', didOnboard: false, deviceName: 'Board camera' });
    expect(loadAppColorScheme('scorer')).toBe('light');
  });

  it('keeps a usable value when storage is unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('blocked'); },
    });

    expect(loadAppColorScheme('frontend')).toBe(DEFAULT_APP_COLOR_SCHEME);
    expect(saveAppColorScheme('scorer', 'light')).toBe('light');
    expect(appColorSchemeManager('frontend').get('dark')).toBe('dark');
    expect(() => appColorSchemeManager('frontend').clear()).not.toThrow();
  });
});
