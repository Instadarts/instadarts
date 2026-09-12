// This browser's own answers about media: whether it takes part, and how a board it receives is
// drawn. Both live in one module and neither leaves the browser.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STRAIGHTEN_VIDEO_KEY,
  loadMediaEnabled,
  loadStraightenVideo,
  saveMediaEnabled,
  saveStraightenVideo,
} from '../../src/client/lib/mediaStorage';

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

describe('straightening a received board', () => {
  it('is off until somebody asks for it', () => {
    // The opposite polarity to the media switch below, and deliberately: this changes how something
    // that already works is drawn, so a browser that has never been asked keeps yesterday's picture.
    expect(loadStraightenVideo()).toBe(false);
    expect(saveStraightenVideo(true)).toBe(true);
    expect(loadStraightenVideo()).toBe(true);
    expect(saveStraightenVideo(false)).toBe(false);
    expect(loadStraightenVideo()).toBe(false);
  });

  it('reads anything it does not recognise as off', () => {
    for (const raw of ['', 'yes', 'true', '2', '0']) {
      values[STRAIGHTEN_VIDEO_KEY] = raw;
      expect(loadStraightenVideo(), raw).toBe(false);
    }
  });

  it('survives storage that refuses to answer', () => {
    // Private mode, or a browser configured to block site data. The preference holds for the page's
    // lifetime and the picture is drawn either way.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
      },
    });
    expect(loadStraightenVideo()).toBe(false);
    expect(saveStraightenVideo(true)).toBe(true);
  });

  it('is a different answer from whether this browser takes part in media at all', () => {
    // One module, two questions, and turning either must not move the other: media is on until it is
    // switched off, and this is off until it is switched on.
    expect(loadMediaEnabled()).toBe(true);
    saveStraightenVideo(true);
    expect(loadMediaEnabled()).toBe(true);
    saveMediaEnabled(false);
    expect(loadStraightenVideo()).toBe(true);
  });
});
