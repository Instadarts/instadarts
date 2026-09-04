import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_ZOOM_STORAGE_KEYS,
  DEFAULT_APP_ZOOM,
  applyAppZoom,
  loadAppZoom,
  parseAppZoom,
  saveAppZoom,
} from '../../src/client/layout/appZoom';
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
    },
  });
});

afterEach(() => {
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('application zoom', () => {
  it('accepts only supported five-percent values', () => {
    expect(parseAppZoom('85')).toBe(85);
    expect(parseAppZoom('87')).toBeNull();
    expect(parseAppZoom('0')).toBeNull();
    expect(parseAppZoom('not a number')).toBeNull();
  });

  it('loads a stored value and defaults malformed data', () => {
    values[APP_ZOOM_STORAGE_KEYS.frontend] = '115';
    expect(loadAppZoom('frontend')).toBe(115);

    values[APP_ZOOM_STORAGE_KEYS.frontend] = '114';
    expect(loadAppZoom('frontend')).toBe(DEFAULT_APP_ZOOM);
  });

  it('rounds, bounds, and persists scalar percentages', () => {
    expect(saveAppZoom('frontend', 83)).toBe(85);
    expect(values[APP_ZOOM_STORAGE_KEYS.frontend]).toBe('85');
    expect(saveAppZoom('frontend', 999)).toBe(150);
    expect(values[APP_ZOOM_STORAGE_KEYS.frontend]).toBe('150');
  });

  it('keeps frontend and scorer preferences separate', () => {
    saveAppZoom('frontend', 85);
    saveAppZoom('scorer', 115);

    expect(loadAppZoom('frontend')).toBe(85);
    expect(loadAppZoom('scorer')).toBe(115);
    expect(values[APP_ZOOM_STORAGE_KEYS.frontend]).toBe('85');
    expect(values[APP_ZOOM_STORAGE_KEYS.scorer]).toBe('115');
  });

  it('applies normalized zoom to the selected application only', () => {
    const properties: Record<string, string> = {};
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        documentElement: {
          style: {
            setProperty: (name: string, value: string) => { properties[name] = value; },
          },
        },
      },
    });

    try {
      expect(applyAppZoom('frontend', 83)).toBe(85);
      expect(applyAppZoom('scorer', 999)).toBe(150);
      expect(properties).toEqual({
        '--instadarts-frontend-zoom': '85%',
        '--instadarts-scorer-zoom': '150%',
      });
    } finally {
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else delete (globalThis as { document?: Document }).document;
    }
  });

  it('survives resetting scorer setup because presentation is not a vision setting', () => {
    saveAppZoom('scorer', 85);
    saveSettings({ model: 's_1280', didOnboard: true, deviceName: 'Board camera' });

    const reset = resetSettings();

    expect(reset).toEqual(loadSettings());
    expect(reset).toMatchObject({ model: 's_960', didOnboard: false, deviceName: 'Board camera' });
    expect(loadAppZoom('scorer')).toBe(85);
    expect(values[APP_ZOOM_STORAGE_KEYS.scorer]).toBe('85');
  });

  it('keeps a usable value when storage is unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('blocked'); },
    });

    expect(loadAppZoom('frontend')).toBe(DEFAULT_APP_ZOOM);
    expect(saveAppZoom('scorer', 85)).toBe(85);
  });
});
