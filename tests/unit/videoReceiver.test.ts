import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_DEFAULTS } from '../../src/shared/config';
import { videoProfile } from '../../src/shared/media';
import type { BoardGeometry } from '../../src/shared/vision/feedGeometry';
import { packVideo } from '../../src/client/media/frames';
import { createVideoReceiver } from '../../src/client/media/videoReceiver';

const FEED_ID = '12345678-1234-4123-8123-123456789abc';
const A: BoardGeometry = { homography: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  lensK1: 0, shot: { x: 0, y: 0, size: 1 } };
const B: BoardGeometry = { ...A, shot: { x: 0.25, y: 0.25, size: 0.5 } };

function packet(seq: number, restingGeometry?: BoardGeometry | null, key = false) {
  // Repeated source timestamps must not confuse pairing at the decoder.
  return packVideo({ feedId: FEED_ID, seq, key, timestamp: 0, restingGeometry }, new Uint8Array([1]));
}

let callbacks: VideoDecoderInit;
const drawImage = vi.fn();
const decode = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage }) }) });
  vi.stubGlobal('VideoDecoder', class {
    state = 'configured';
    constructor(init: VideoDecoderInit) { callbacks = init; }
    configure() {}
    decode = decode;
    close() { this.state = 'closed'; }
  });
  vi.stubGlobal('EncodedVideoChunk', class {
    constructor(init: EncodedVideoChunkInit) { Object.assign(this, init); }
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

function paint(seq: number) {
  const close = vi.fn();
  callbacks.output({ timestamp: seq, close } as unknown as VideoFrame);
  expect(close).toHaveBeenCalledOnce();
}
function receiver() {
  const onFrame = vi.fn();
  const requestKeyframe = vi.fn();
  const feed = createVideoReceiver({ feedId: FEED_ID, profile: videoProfile(CONFIG_DEFAULTS.media.video),
    requestKeyframe, onFrame });
  return { feed, onFrame, requestKeyframe };
}

describe('resting geometry at decoder output', () => {
  it('commits the matching geometry only when that frame is painted', () => {
    const { feed, onFrame } = receiver();
    feed.accept(packet(0, A, true));
    feed.accept(packet(1));
    feed.accept(packet(2, B));
    expect(feed.stats().restingGeometry).toBeNull();
    expect(drawImage).not.toHaveBeenCalled();
    onFrame.mockImplementation(() => expect(feed.stats().restingGeometry).toEqual(A));
    paint(0);
    paint(1);
    onFrame.mockImplementation(() => expect(feed.stats().restingGeometry).toEqual(B));
    paint(2);
    expect(decode.mock.calls.map(([chunk]) => chunk.timestamp)).toEqual([0, 1, 2]);
    expect(onFrame).toHaveBeenCalledTimes(3);
    feed.close();
  });

  it('holds through an unchanged keyframe and resets with the restarted camera picture', () => {
    const { feed } = receiver();
    feed.accept(packet(0, A, true));
    paint(0);
    feed.accept(packet(1, undefined, true));
    paint(1);
    expect(feed.stats().restingGeometry).toEqual(A);
    feed.accept(packet(2, null, true));
    feed.accept(packet(3));
    expect(feed.stats().restingGeometry).toEqual(A);
    paint(2);
    expect(feed.stats().restingGeometry).toBeNull();
    paint(3);
    expect(feed.stats().restingGeometry).toBeNull();
    feed.accept(packet(4, B));
    paint(4);
    expect(feed.stats().restingGeometry).toEqual(B);
    feed.close();
  });

  it('carries resolved state through skipped decoder outputs and ignores late outputs', () => {
    const { feed } = receiver();
    feed.accept(packet(0, A, true));
    feed.accept(packet(1));
    paint(1);
    expect(feed.stats().restingGeometry).toEqual(A);
    feed.accept(packet(2, null));
    feed.accept(packet(3));
    paint(3);
    paint(0);
    expect(feed.stats().restingGeometry).toBeNull();
    expect(drawImage).toHaveBeenCalledTimes(2);
    feed.close();
  });

  it('does not apply stale or unsynchronized packets and repairs a lost reset on a keyframe', () => {
    const { feed, requestKeyframe } = receiver();
    feed.accept(packet(0, A, true));
    paint(0);
    // Reset on sequence 1 was lost in transit; delta 2 is unusable.
    feed.accept(packet(2, B));
    feed.accept(packet(1, null));
    expect(feed.stats().restingGeometry).toEqual(A);
    expect(decode).toHaveBeenCalledOnce();
    expect(requestKeyframe).toHaveBeenCalledOnce();
    feed.accept(packet(3, null, true));
    paint(3);
    expect(feed.stats().restingGeometry).toBeNull();
    feed.close();
  });

  it('keeps painted geometry when decode throws synchronously', () => {
    const { feed } = receiver();
    feed.accept(packet(0, A, true));
    paint(0);
    decode.mockImplementationOnce(() => { throw new Error('decode failed'); });
    feed.accept(packet(1, B));
    paint(1);
    expect(feed.stats().restingGeometry).toEqual(A);
    feed.accept(packet(2, undefined, true));
    paint(2);
    expect(feed.stats().restingGeometry).toEqual(A);
    feed.close();
  });

  it('discards pending metadata on asynchronous decode failure and close', () => {
    const { feed, onFrame } = receiver();
    feed.accept(packet(0, A, true));
    paint(0);
    feed.accept(packet(1, B));
    callbacks.error(new DOMException('decode failed'));
    paint(1);
    expect(feed.stats().restingGeometry).toEqual(A);
    feed.accept(packet(2, null, true));
    feed.close();
    paint(2);
    expect(feed.stats().restingGeometry).toEqual(A);
    expect(onFrame).toHaveBeenCalledOnce();
  });
});

describe('keyframe recovery retries', () => {
  it('retries a lost repair during packet silence and stops after repair', () => {
    const { feed, requestKeyframe } = receiver();
    feed.accept(packet(0, A, true));
    feed.accept(packet(2));
    expect(requestKeyframe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(499);
    expect(requestKeyframe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); // The first requested repair was lost.
    expect(requestKeyframe).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(500);
    expect(requestKeyframe).toHaveBeenCalledTimes(3);
    feed.accept(packet(5, B, true));
    paint(5);
    expect(feed.stats()).toMatchObject({ recoveryRequests: 3, recoveries: 1, restingGeometry: B });
    vi.advanceTimersByTime(2000);
    expect(requestKeyframe).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    feed.close();
  });

  it('uses one timer before the first keyframe and ignores stale keyframes', () => {
    const { feed, requestKeyframe } = receiver();
    feed.accept(packet(2));
    feed.accept(packet(3));
    feed.accept(packet(1, A, true));
    expect(requestKeyframe).toHaveBeenCalledTimes(1);
    expect(decode).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(requestKeyframe).toHaveBeenCalledTimes(2);
    feed.close();
    vi.advanceTimersByTime(2000);
    expect(requestKeyframe).toHaveBeenCalledTimes(2);
  });

  it('does not complete recovery when submitting the keyframe throws', () => {
    const { feed, requestKeyframe } = receiver();
    feed.accept(packet(1));
    decode.mockImplementationOnce(() => { throw new Error('busy'); });
    feed.accept(packet(2, A, true));
    expect(feed.stats()).toMatchObject({ started: false, recoveries: 0 });
    vi.advanceTimersByTime(500);
    expect(requestKeyframe).toHaveBeenCalledTimes(2);
    feed.accept(packet(3, A, true));
    expect(feed.stats().recoveries).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    feed.close();
  });

  it('retries existing decoder error recovery without adding timers per error', () => {
    const { feed, requestKeyframe } = receiver();
    feed.accept(packet(0, A, true));
    callbacks.error(new DOMException('decode failed'));
    callbacks.error(new DOMException('decode failed again'));
    expect(requestKeyframe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(requestKeyframe).toHaveBeenCalledTimes(3);
    feed.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
