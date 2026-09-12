import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_DEFAULTS } from '../../src/shared/config';
import { videoProfile } from '../../src/shared/media';
import type { BoardGeometry } from '../../src/shared/vision/feedGeometry';
import { unpackVideo } from '../../src/client/media/frames';
import type { Mesh } from '../../src/client/media/mesh';
import { createVideoFeedClock, createVideoPublisher } from '../../src/client/media/videoPublisher';

const FEED_ID = '12345678-1234-4123-8123-123456789abc';
const GEOMETRY: BoardGeometry = { homography: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  lensK1: 0, shot: { x: 0, y: 0, size: 1 } };
let callbacks: VideoEncoderInit;
const encode = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('VideoEncoder', class {
    state = 'configured';
    encodeQueueSize = 0;
    constructor(init: VideoEncoderInit) { callbacks = init; }
    configure() {}
    encode = encode;
    close() { this.state = 'closed'; }
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

function harness() {
  let geometry: BoardGeometry | null = GEOMETRY;
  const close = vi.fn();
  const sendMedia = vi.fn((_data: ArrayBuffer) => true);
  const mesh = { viewers: () => [{ peerId: 'viewer', ready: true, maxMessageBytes: 65536, bufferedAmount: 0, sendMedia }] } as unknown as Mesh;
  const clock = createVideoFeedClock();
  const start = () => createVideoPublisher({ mesh, profile: videoProfile(CONFIG_DEFAULTS.media.video),
    feedId: FEED_ID, audience: () => ['opponent'], accepted: () => new Set(['viewer']), clock,
    source: { element: () => null, grab: () => ({ frame: { close } as unknown as VideoFrame, restingGeometry: geometry }) } });
  const tick = (key: boolean) => {
    const before = encode.mock.calls.length;
    vi.advanceTimersToNextTimer();
    expect(encode.mock.calls.length).toBe(before + 1);
    callbacks.output({ type: key ? 'key' : 'delta', byteLength: 1, timestamp: 0,
      copyTo: (target: Uint8Array) => target.set([1]) } as unknown as EncodedVideoChunk, {});
    return unpackVideo(sendMedia.mock.calls.at(-1)![0])!.header;
  };
  return { start, tick, close, sendMedia, setGeometry: (value: BoardGeometry | null) => { geometry = value; } };
}

describe('resting geometry publication', () => {
  it('repeats resting state on keyframes and emits reset on camera restart without changing the feed', () => {
    const h = harness();
    let publisher = h.start();
    expect(h.tick(true).restingGeometry).toEqual(GEOMETRY);
    expect(h.tick(false).restingGeometry).toBeUndefined();
    // A held zoom or temporary encoder restart still reads the runtime's resting state.
    expect(h.tick(true).restingGeometry).toEqual(GEOMETRY);
    publisher.stop();
    publisher = h.start();
    expect(h.tick(true).restingGeometry).toEqual(GEOMETRY);
    publisher.stop();
    // A camera stop clears the runtime state; the next encoder must explicitly reset receivers.
    h.setGeometry(null);
    publisher = h.start();
    const reset = h.tick(true);
    expect(reset.feedId).toBe(FEED_ID);
    expect(reset.seq).toBe(4);
    expect(reset.restingGeometry).toBeNull();
    expect(h.tick(false).restingGeometry).toBeUndefined();
    expect(h.tick(true).restingGeometry).toBeNull();
    h.setGeometry(GEOMETRY);
    expect(h.tick(false).restingGeometry).toEqual(GEOMETRY);
    expect(publisher.stats().described).toBe(1);
    expect(h.close).toHaveBeenCalledTimes(8);
    publisher.stop();
  });

  it('retries resets nobody received and resets even without an encoder restart', () => {
    const h = harness();
    const publisher = h.start();
    h.tick(true);
    h.setGeometry(null);
    h.sendMedia.mockReturnValueOnce(false);
    expect(h.tick(false).restingGeometry).toBeNull();
    expect(h.tick(true).restingGeometry).toBeNull();
    expect(h.tick(false).restingGeometry).toBeUndefined();
    publisher.stop();
  });
});
