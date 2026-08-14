// Which camera a phone opens when nobody has told it.
//
// Pure decision logic sitting in front of `getUserMedia`, so it is worth pinning here rather than
// discovering on a mount: getting it wrong means a phone on a wall filming the room instead of the
// board, and the person who set it up is not standing next to it any more.

import { describe, it, expect, beforeEach } from 'vitest';
import { preferredCamera } from '../../src/client/vision/camera';

const SETTINGS_KEY = 'instadarts_scorer_settings';
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  } as Storage;
});

const remember = (camera: string) => store.set(SETTINGS_KEY, JSON.stringify({ camera }));
const choose = (...labels: string[]) =>
  preferredCamera(labels.map((label, i) => ({ deviceId: `device-${i}`, label })))?.label ?? null;

describe('choosing a camera with nothing stored', () => {
  it('has nothing to offer when the browser lists no cameras', () => {
    expect(choose()).toBe(null);
  });

  it('takes the only one there is, whatever it is called', () => {
    expect(choose('FaceTime HD Camera')).toBe('FaceTime HD Camera');
  });

  it('prefers the back camera, which is the one a phone on a mount points at the board', () => {
    // The browser tends to enumerate the selfie camera first, so "the first one" is usually wrong.
    expect(choose('Front Camera', 'Back Camera')).toBe('Back Camera');
    expect(choose('camera2 1, facing front', 'camera2 0, facing back')).toBe('camera2 0, facing back');
    expect(choose('Integrated Webcam', 'Rear Camera')).toBe('Rear Camera');
  });

  it('does not guess between two rear lenses', () => {
    // A handset reporting a wide and an ultra-wide rear camera is asking a question this cannot
    // answer. Falling back to the first leaves it visibly wrong, which is what sends somebody to
    // the picker; picking one at random would be wrong in a way nobody would notice.
    expect(choose('Front Camera', 'Back Dual Wide Camera', 'Back Ultra Wide Camera')).toBe('Front Camera');
  });

  it('does not read "back" out of the middle of a word', () => {
    expect(choose('Playback Capture Device', 'Front Camera')).toBe('Playback Capture Device');
  });
});

describe('choosing a camera with one stored', () => {
  it('opens the one this device was set up with', () => {
    remember('Back Camera');
    expect(choose('Front Camera', 'Back Camera')).toBe('Back Camera');
  });

  it('outranks the back-camera guess, since somebody chose it on purpose', () => {
    remember('Front Camera');
    expect(choose('Front Camera', 'Back Camera')).toBe('Front Camera');
  });

  it('falls back rather than failing when the stored camera is not plugged in', () => {
    remember('Some camera that went away');
    expect(choose('Front Camera', 'Back Camera')).toBe('Back Camera');
  });
});
