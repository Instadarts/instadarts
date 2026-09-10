import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVideoFeedClock, createVideoPublisher } from '../../src/client/media/videoPublisher';
import { unpackVideo } from '../../src/client/media/frames';
import { videoProfile, maxBufferedBytes } from '../../src/shared/media';
import { CONFIG_DEFAULTS } from '../../src/shared/config';
import type { Mesh } from '../../src/client/media/mesh';

const profile = { ...videoProfile(CONFIG_DEFAULTS.media.video), keyFrameIntervalMs: 30_000 };
const feedId = '12345678-1234-4123-8123-123456789abc';
let now = 1000;
let busy = 0;
let output: VideoEncoderInit['output'];
const encode = vi.fn();
const close = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  now = 1000;
  busy = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('VideoEncoder', class {
    state = 'configured';
    get encodeQueueSize() { return busy; }
    constructor(init: VideoEncoderInit) { output = init.output; }
    configure() {}
    encode = encode;
    close() { this.state = 'closed'; }
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks(); });

function camera() {
  let callback: VideoFrameRequestCallback;
  const element = {
    requestVideoFrameCallback: vi.fn((cb: VideoFrameRequestCallback) => { callback = cb; return 42; }),
    cancelVideoFrameCallback: vi.fn(),
  };
  return {
    element: element as unknown as HTMLVideoElement,
    deliver: (mediaTime?: number, presentedFrames?: number) => callback(now, { mediaTime, presentedFrames } as VideoFrameCallbackMetadata),
  };
}

function harness(timer = false) {
  const firstCamera = camera();
  let sourceElement: HTMLVideoElement | null = timer ? null : firstCamera.element;
  const a = { peerId: 'a', ready: true, bufferedAmount: 0, maxMessageBytes: 65536, sendMedia: vi.fn((_packet: ArrayBuffer) => true) };
  const b = { ...a, peerId: 'b', sendMedia: vi.fn((_packet: ArrayBuffer) => true) };
  const accepted = new Set(['a', 'b']);
  const links = [a, b];
  const grab = vi.fn((_size: number, timestamp: number) => ({
    frame: { close, timestamp } as unknown as VideoFrame, restingGeometry: null,
  }));
  const publisher = createVideoPublisher({
    profile, feedId, clock: createVideoFeedClock(), audience: () => ['opponent'], accepted: () => accepted,
    mesh: { viewers: () => links } as unknown as Mesh,
    source: { element: () => sourceElement, grab },
  });
  function emit(key = encode.mock.calls.at(-1)![1].keyFrame, bytes = 1) {
    output({ type: key ? 'key' : 'delta', byteLength: bytes,
      timestamp: encode.mock.calls.at(-1)![0].timestamp,
      copyTo: (target: Uint8Array) => target.fill(1),
    } as unknown as EncodedVideoChunk, {});
  }
  function tick(at: number) {
    now = at;
    firstCamera.deliver(at / 1000);
    emit();
  }
  return { publisher, a, b, accepted, links, grab, emit, tick, camera: firstCamera,
    setElement: (element: HTMLVideoElement | null) => { sourceElement = element; } };
}

describe('publisher repair per viewer', () => {
  it('withholds dependent deltas and repairs only after the viewer drains', () => {
    const h = harness();
    h.tick(1000);
    expect(h.publisher.stats().awaitingKeyframe).toBe(0);
    h.b.bufferedAmount = maxBufferedBytes(profile) + 1;
    h.tick(1100);
    expect(h.publisher.stats()).toMatchObject({ dropped: 1, awaitingKeyframe: 1 });
    h.tick(1500);
    expect(encode.mock.calls.at(-1)![1].keyFrame).toBe(false);
    expect(h.a.sendMedia).toHaveBeenCalledTimes(3);
    expect(h.b.sendMedia).toHaveBeenCalledTimes(1);
    h.b.bufferedAmount = 0;
    h.tick(1600);
    expect(encode.mock.calls.at(-1)![1].keyFrame).toBe(true);
    expect(h.b.sendMedia).toHaveBeenCalledTimes(2);
    expect(h.publisher.stats().awaitingKeyframe).toBe(0);
    h.publisher.stop();
  });

  it.each(['oversize', 'send failure'] as const)('keeps %s pending despite keyframes reaching another viewer', (failure) => {
    const h = harness();
    h.tick(1000);
    if (failure === 'oversize') h.b.maxMessageBytes = 1;
    else h.b.sendMedia.mockReturnValue(false);
    h.tick(1100);
    h.tick(1500);
    expect(encode.mock.calls.at(-1)![1].keyFrame).toBe(true);
    expect(h.publisher.stats().awaitingKeyframe).toBe(1);
    h.b.maxMessageBytes = 65536;
    h.b.sendMedia.mockReturnValue(true);
    h.tick(1600);
    expect(encode.mock.calls.at(-1)![1].keyFrame).toBe(false);
    h.tick(2000);
    expect(encode.mock.calls.at(-1)![1].keyFrame).toBe(true);
    expect(h.publisher.stats().awaitingKeyframe).toBe(0);
    expect(failure === 'oversize' ? h.publisher.stats().oversize : h.publisher.stats().sendFailures).toBe(2);
    h.publisher.stop();
  });

  it('does not clear a newer request with an in-flight keyframe', () => {
    const h = harness();
    h.tick(1000);
    h.publisher.requestKeyframe('b');
    now = 1500;
    h.camera.deliver(1.5);
    expect(encode.mock.calls.at(-1)![1].keyFrame).toBe(true);
    h.publisher.requestKeyframe('b');
    h.emit();
    expect(h.publisher.stats().awaitingKeyframe).toBe(1);
    h.tick(1600);
    expect(h.b.sendMedia).toHaveBeenCalledTimes(2);
    h.tick(2000);
    expect(h.publisher.stats().awaitingKeyframe).toBe(0);
    h.publisher.stop();
  });

  it('prunes departed viewers and does not re-key for an unwritable viewer', () => {
    const h = harness();
    h.tick(1000);
    h.publisher.requestKeyframe('b');
    h.b.ready = false;
    h.tick(1600);
    expect(encode.mock.calls.at(-1)![1].keyFrame).toBe(false);
    h.accepted.delete('b');
    expect(h.publisher.stats().awaitingKeyframe).toBe(0);
    h.publisher.requestKeyframe('stranger');
    expect(h.publisher.stats().awaitingKeyframe).toBe(0);
    h.publisher.stop();
    expect(h.publisher.stats().awaitingKeyframe).toBe(0);
  });

  it('recognizes newly accepted viewers, retains periodic keyframes, and preserves packet sequence', () => {
    const h = harness();
    h.accepted.delete('b');
    h.tick(1000);
    h.accepted.add('b');
    h.tick(1100);
    expect(h.b.sendMedia).not.toHaveBeenCalled();
    h.tick(1500);
    expect(h.b.sendMedia).toHaveBeenCalledTimes(1);
    expect(unpackVideo(h.b.sendMedia.mock.calls[0][0])!.header.seq).toBe(2);
    h.tick(31500);
    expect(encode.mock.calls.at(-1)![1].keyFrame).toBe(true);
    h.publisher.stop();
  });
});

describe('source-time pacing', () => {
  it('keeps publishing and repairing when new camera frames have a frozen mediaTime', () => {
    const h = harness();
    for (let i = 0; i < 150; i++) {
      now = 1000 + i * 1000 / 15;
      const before = encode.mock.calls.length;
      h.camera.deliver(0, i + 1);
      if (encode.mock.calls.length > before) h.emit();
      if (i === 1) h.publisher.requestKeyframe('b');
    }
    expect(encode).toHaveBeenCalledTimes(150);
    expect(h.publisher.stats().awaitingKeyframe).toBe(0);
    expect(h.publisher.stats().frames).toBe(150);
    expect(h.publisher.stats()).toMatchObject({ pacingClock: 'callback', submitted: 150, encoded: 150 });
    h.publisher.stop();
  });

  it('falls back after a stalled clock even without a usable presented-frame counter', () => {
    const h = harness();
    for (let i = 0; i < 150; i++) {
      now = 1000 + i * 1000 / 15;
      const before = encode.mock.calls.length;
      h.camera.deliver(0);
      if (encode.mock.calls.length > before) h.emit();
    }
    expect(encode.mock.calls.length).toBeGreaterThanOrEqual(146);
    expect(h.publisher.stats().awaitingKeyframe).toBe(0);
    h.publisher.stop();
  });

  it('keeps a stable fallback phase when source timestamps advance only intermittently', () => {
    const h = harness();
    for (let i = 0; i < 300; i++) {
      now = 1000 + i * 1000 / 30;
      const before = encode.mock.calls.length;
      h.camera.deliver(Math.floor(i / 3) / 10, i + 1);
      if (encode.mock.calls.length > before) h.emit();
    }
    expect(encode.mock.calls.length).toBeGreaterThanOrEqual(150);
    expect(encode.mock.calls.length).toBeLessThanOrEqual(151);
    expect(h.publisher.stats().pacingClock).toBe('callback');
    h.publisher.stop();
  });

  it('tries source time again when a replacement camera supplies a working clock', () => {
    const h = harness();
    h.camera.deliver(0, 1);
    h.emit();
    now = 1100;
    h.camera.deliver(0, 2);
    h.emit();
    expect(h.publisher.stats().pacingClock).toBe('callback');
    const replacement = camera();
    h.setElement(replacement.element);
    h.camera.deliver(0, 3);
    now = 1200;
    replacement.deliver(0, 1);
    h.emit();
    now = 1300;
    replacement.deliver(0.1, 2);
    h.emit();
    expect(h.publisher.stats().pacingClock).toBe('media');
    h.publisher.stop();
  });

  it.each([0, 2, 5])('encodes all 150 source frames with alternating %i ms callback delay', (delay) => {
    const h = harness();
    for (let i = 0; i < 150; i++) {
      now = 1000 + i * 1000 / 15 + (i % 2 ? delay : 0);
      h.camera.deliver(i / 15);
      h.emit();
    }
    expect(encode).toHaveBeenCalledTimes(150);
    expect(close).toHaveBeenCalledTimes(150);
    expect(h.publisher.stats().pacingSkipped).toBe(0);
    h.publisher.stop();
  });

  it.each([10, 30])('samples a %i fps source without duplicating frames', (rate) => {
    const h = harness();
    for (let i = 0; i < rate * 10; i++) {
      now = 1000 + i * 1000 / rate;
      const before = encode.mock.calls.length;
      h.camera.deliver(i / rate);
      if (encode.mock.calls.length > before) h.emit();
    }
    expect(encode).toHaveBeenCalledTimes(Math.min(rate, 15) * 10);
    h.publisher.stop();
  });

  it('recovers from stalls and busy encoders without catch-up bursts or resetting feed time', () => {
    const h = harness();
    h.tick(1000);
    busy = 3;
    now = 1100;
    h.camera.deliver(1.1);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(h.publisher.stats().encoderBusy).toBe(1);
    busy = 0;
    h.tick(10000);
    h.camera.deliver(10); // duplicate source frame
    expect(encode).toHaveBeenCalledTimes(2);
    now = 10100;
    h.camera.deliver(0); // source timeline resets
    h.emit();
    expect(encode).toHaveBeenCalledTimes(3);
    const packet = unpackVideo(h.a.sendMedia.mock.calls.at(-1)![0])!.header;
    expect(packet.seq).toBe(2);
    expect(packet.timestamp).toBe(9_100_000);
    h.publisher.stop();
  });

  it('resets sampling on timing changes and cancels on the registered element', () => {
    const h = harness();
    h.tick(1000);
    now = 1001;
    h.camera.deliver(); // media time unavailable; wall clock takes over
    h.emit();
    expect(encode).toHaveBeenCalledTimes(2);
    const replacement = camera();
    h.setElement(replacement.element);
    h.publisher.stop();
    expect(h.camera.element.cancelVideoFrameCallback).toHaveBeenCalledWith(42);
    expect(replacement.element.cancelVideoFrameCallback).not.toHaveBeenCalled();
  });

  it('resets the sampling phase on source replacement', () => {
    const h = harness();
    h.tick(1000);
    const replacement = camera();
    h.setElement(replacement.element);
    h.camera.deliver(1.01); // old element's callback only registers the new one
    replacement.deliver(0);
    h.emit();
    expect(encode).toHaveBeenCalledTimes(2);
    h.publisher.stop();
  });

  it('absorbs wall-clock callback jitter when source timing is unavailable', () => {
    const h = harness();
    for (let i = 0; i < 150; i++) {
      now = 1000 + i * 1000 / 15 + (i % 2 ? 0 : 5);
      h.camera.deliver();
      h.emit();
    }
    expect(encode).toHaveBeenCalledTimes(150);
    h.publisher.stop();
  });

  it('subtracts processing time from the fallback timer and skips expired deadlines', () => {
    vi.mocked(performance.now).mockRestore(); // fake-timer monotonic clock
    const h = harness(true);
    encode.mockImplementationOnce(() => vi.advanceTimersByTime(20));
    vi.advanceTimersToNextTimer();
    const firstAt = performance.now();
    h.emit();
    vi.advanceTimersToNextTimer();
    h.emit();
    expect(performance.now() - firstAt).toBeGreaterThanOrEqual(45);
    expect(performance.now() - firstAt).toBeLessThan(48);
    encode.mockImplementationOnce(() => vi.advanceTimersByTime(500));
    vi.advanceTimersToNextTimer();
    h.emit();
    const calls = encode.mock.calls.length;
    vi.advanceTimersByTime(1);
    expect(encode).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(1);
    h.publisher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
