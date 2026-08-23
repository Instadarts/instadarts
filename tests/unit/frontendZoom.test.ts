import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FRONTEND_ZOOM,
  FRONTEND_ZOOM_STORAGE_KEY,
  loadFrontendZoom,
  parseFrontendZoom,
  saveFrontendZoom,
} from '../../src/client/layout/frontendZoom';

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

describe('frontend zoom', () => {
  it('accepts only supported five-percent values', () => {
    expect(parseFrontendZoom('85')).toBe(85);
    expect(parseFrontendZoom('87')).toBeNull();
    expect(parseFrontendZoom('0')).toBeNull();
    expect(parseFrontendZoom('not a number')).toBeNull();
  });

  it('loads the one global stored value and defaults malformed data', () => {
    values[FRONTEND_ZOOM_STORAGE_KEY] = '115';
    expect(loadFrontendZoom()).toBe(115);

    values[FRONTEND_ZOOM_STORAGE_KEY] = '114';
    expect(loadFrontendZoom()).toBe(DEFAULT_FRONTEND_ZOOM);
  });

  it('rounds, bounds, and persists changes as one scalar percentage', () => {
    expect(saveFrontendZoom(83)).toBe(85);
    expect(values[FRONTEND_ZOOM_STORAGE_KEY]).toBe('85');
    expect(saveFrontendZoom(999)).toBe(150);
    expect(values[FRONTEND_ZOOM_STORAGE_KEY]).toBe('150');
  });

  it('keeps a usable value when storage is unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('blocked'); },
    });

    expect(loadFrontendZoom()).toBe(DEFAULT_FRONTEND_ZOOM);
    expect(saveFrontendZoom(85)).toBe(85);
  });
});
