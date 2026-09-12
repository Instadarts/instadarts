import { test, expect } from '@playwright/test';

for (const frozenCameraClock of [false, true]) {
test(`repairs a lost delta and a lost repair keyframe (${frozenCameraClock ? 'camera with zero timestamps' : 'timer'})`, async ({ page }) => {
  await page.goto('/?e2e=1');
  const result = await page.evaluate(async ({ paths, frozenCameraClock }) => {
    const { createVideoPublisher, createVideoFeedClock }: typeof import('../../src/client/media/videoPublisher') = await import(paths[0]);
    const { createVideoReceiver }: typeof import('../../src/client/media/videoReceiver') = await import(paths[1]);
    const { unpackVideo }: typeof import('../../src/client/media/frames') = await import(paths[2]);
    const profile = { codec: 'avc1.42001f', width: 320, height: 320, frameRate: 15, bitrate: 500_000, keyFrameIntervalMs: 30_000 };
    const feedId = '12345678-1234-4123-8123-123456789abc';
    const canvas = new OffscreenCanvas(320, 320);
    const context = canvas.getContext('2d')!;
    let frameNumber = 0;
    let painted = 0;
    let lostDeltaAt: number | null = null;
    let lostRepair = false;
    let publisher: ReturnType<typeof createVideoPublisher>;
    // Reproduce Firefox/Windows camera metadata: new presentedFrames, but mediaTime always zero.
    // Encoding and decoding still use the real browser codecs.
    const camera = document.createElement('video');
    let presentedFrames = 0;
    camera.requestVideoFrameCallback = (callback) => window.setTimeout(() => {
      callback(performance.now(), { mediaTime: 0, presentedFrames: ++presentedFrames } as VideoFrameCallbackMetadata);
    }, 1000 / 30);
    camera.cancelVideoFrameCallback = (handle) => window.clearTimeout(handle);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const repaired = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const receiver = createVideoReceiver({
      profile, feedId,
      requestKeyframe: () => publisher.requestKeyframe('viewer'),
      onFrame: () => {
        painted++;
        if (lostRepair && receiver.stats().recoveries > 0) resolve();
      },
    });
    const link = {
      peerId: 'viewer', ready: true, bufferedAmount: 0, maxMessageBytes: 1_000_000,
      sendMedia(data: ArrayBuffer) {
        const { header } = unpackVideo(data)!;
        // Successful local sends with packets lost in transit, beyond the publisher's visibility.
        if (!header.key && lostDeltaAt === null) { lostDeltaAt = performance.now(); return true; }
        if (header.key && lostDeltaAt !== null && !lostRepair) { lostRepair = true; return true; }
        receiver.accept(data);
        return true;
      },
    };
    publisher = createVideoPublisher({
      profile, feedId, clock: createVideoFeedClock(),
      audience: () => ['opponent'], accepted: () => new Set(['viewer']),
      mesh: { viewers: () => [link] } as unknown as import('../../src/client/media/mesh').Mesh,
      source: {
        element: () => frozenCameraClock ? camera : null,
        grab: (_size, timestamp, duration) => {
          context.fillStyle = '#123456';
          context.fillRect(0, 0, 320, 320);
          context.fillStyle = '#ffaa00';
          context.fillRect((frameNumber++ * 9) % 250, 60, 70, 150);
          return { frame: new VideoFrame(canvas, { timestamp, duration }), restingGeometry: null };
        },
      },
    });
    const timeout = setTimeout(() => reject(new Error(JSON.stringify({ publisher: publisher.stats(), receiver: receiver.stats(), lostRepair }))), 5000);
    try {
      await repaired;
      return { elapsedMs: performance.now() - lostDeltaAt!, painted, lostRepair,
        publisher: publisher.stats(), receiver: receiver.stats() };
    } finally {
      clearTimeout(timeout);
      publisher.stop();
      receiver.close();
    }
  }, { paths: ['/media/videoPublisher.ts', '/media/videoReceiver.ts', '/media/frames.ts'], frozenCameraClock });
  expect(result.lostRepair).toBe(true);
  expect(result.receiver.recoveryRequests).toBeGreaterThanOrEqual(2);
  expect(result.receiver.recoveries).toBe(1);
  expect(result.painted).toBeGreaterThan(1);
  expect(result.elapsedMs).toBeLessThan(5000);
  expect(result.publisher.error).toBeUndefined();
  expect(result.receiver.error).toBeUndefined();
  expect(result.publisher.pacingClock).toBe(frozenCameraClock ? 'callback' : 'timer');
});
}
