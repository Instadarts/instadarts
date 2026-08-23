import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_ZOOM_STORAGE_KEYS,
  DEFAULT_APP_ZOOM,
  loadAppZoom,
  parseAppZoom,
  saveAppZoom,
} from '../../src/client/layout/appZoom';

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

  it('keeps a usable value when storage is unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('blocked'); },
    });

    expect(loadAppZoom('frontend')).toBe(DEFAULT_APP_ZOOM);
    expect(saveAppZoom('scorer', 85)).toBe(85);
  });
});
