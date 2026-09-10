import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisionRuntime } from '../../src/client/vision/visionRuntime';
import { captureCrop, type Capture } from '../../src/client/vision/stillCapture';
import { stillSize } from '../../src/client/lib/appConfig';
import { STILL } from '../../src/shared/media';

const mocks = vi.hoisted(() => ({
  camera: {
    active: false,
    start: vi.fn(), stop: vi.fn(), storedZoom: vi.fn(() => 2), applyZoom: vi.fn(async () => 2),
  },
  arm: vi.fn(), reset: vi.fn(),
  loadModel: vi.fn(),
}));
vi.mock('../../src/client/vision/camera', () => ({
  createCamera: () => mocks.camera, listCameras: vi.fn(), preferredCamera: vi.fn(),
}));
vi.mock('../../src/client/vision/model', () => ({ loadModel: mocks.loadModel, unloadModel: vi.fn() }));
vi.mock('../../src/client/vision/motion', () => ({ createMotionDetector: () => ({ arm: mocks.arm, reset: mocks.reset }) }));
vi.mock('../../src/client/vision/postprocess', () => ({ postprocess: () => [[]] }));
vi.mock('../../src/client/vision/predictionPipeline', () => ({ processPredictions: () => ({
  homography: [[1e6, 0, 0], [0, 1e6, 0], [0, 0, 1]], tips: [],
}) }));
vi.mock('../../src/client/vision/stillCapture', async (original) => ({
  ...await original<typeof import('../../src/client/vision/stillCapture')>(), captureCrop: vi.fn(),
}));

const capture = vi.mocked(captureCrop);
const result: Capture = { blob: new Blob(['jpeg']), timing: { drawMs: 1, encodeMs: 2 } };
function deferred() {
  let resolve!: (result: Capture | null) => void;
  const promise = new Promise<Capture | null>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  const video = { videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
  const onTips = vi.fn();
  const onFrame = vi.fn();
  return { video, onTips, onFrame, runtime: createVisionRuntime({ video, onTips, onFrame }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  capture.mockReset().mockResolvedValue(result);
  mocks.camera.active = false;
  mocks.camera.start.mockImplementation(async () => {
    mocks.camera.active = true;
    return { label: 'camera', settings: { width: 1280, height: 720 } };
  });
  mocks.camera.stop.mockImplementation(() => { mocks.camera.active = false; });
  mocks.loadModel.mockResolvedValue({ run: async () => ({ outputs: [[], []], preprocessMode: 'test' }) });
});

describe('camera still warm-up', () => {
  it('uses the real capture settings once per session, after zoom and before scanning', async () => {
    const h = harness();
    await h.runtime.start('camera');
    expect(capture).toHaveBeenCalledExactlyOnceWith(h.video, { x: 280, y: 0, size: 720 }, stillSize(), STILL.mime, STILL.quality);
    expect(mocks.camera.applyZoom.mock.invocationCallOrder[0]).toBeLessThan(capture.mock.invocationCallOrder[0]);
    expect(capture.mock.invocationCallOrder[0]).toBeLessThan(mocks.arm.mock.invocationCallOrder[0]);
    expect(h.onTips).not.toHaveBeenCalled();
    expect(h.onFrame).not.toHaveBeenCalled();
    expect(h.runtime.located).toBe(false);
    h.runtime.directVideo(null, 0, 0);
    expect(capture).toHaveBeenCalledTimes(1);
    await h.runtime.stop();
    await h.runtime.start('camera');
    expect(capture).toHaveBeenCalledTimes(2);
    await h.runtime.stop();
  });

  it('queues a real still behind warm-up, preserving its requested crop', async () => {
    const warm = deferred();
    capture.mockReturnValueOnce(warm.promise);
    const h = harness();
    const starting = h.runtime.start('camera');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(mocks.arm).not.toHaveBeenCalled();
    await h.runtime.infer();
    const photo = h.runtime.captureStill({ cx: 0.5, cy: 0.5, size: 0.2 });
    await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(1);
    warm.resolve(result);
    await starting;
    expect(await photo).toBe(result);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1][1].size).toBeLessThan(720);
    expect(mocks.arm).toHaveBeenCalledTimes(1);
    await h.runtime.stop();
  });

  it('tolerates warm-up failure and allows subsequent real captures', async () => {
    capture.mockRejectedValueOnce(new Error('no frame yet'));
    const h = harness();
    await expect(h.runtime.start('camera')).resolves.toMatchObject({ label: 'camera' });
    expect(mocks.arm).toHaveBeenCalledTimes(1);
    await h.runtime.infer();
    expect(await h.runtime.captureStill({ cx: 0.5, cy: 0.5, size: 0.2 })).toBe(result);
    await h.runtime.stop();
  });

  it('does not arm or capture a queued request after the camera stops', async () => {
    const warm = deferred();
    capture.mockReturnValueOnce(warm.promise);
    const h = harness();
    const starting = h.runtime.start('camera');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    await h.runtime.infer();
    const photo = h.runtime.captureStill({ cx: 0.5, cy: 0.5, size: 0.2 });
    await h.runtime.stop();
    warm.resolve(result);
    await starting;
    expect(await photo).toBeNull();
    expect(mocks.arm).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(h.runtime.cameraResolution).toBeNull();
  });

  it('serializes warm-ups across a restart and arms only the new session', async () => {
    const first = deferred();
    const second = deferred();
    capture.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const h = harness();
    const oldStart = h.runtime.start('old');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    await h.runtime.stop();
    const newStart = h.runtime.start('new');
    await vi.waitFor(() => expect(mocks.camera.start).toHaveBeenCalledTimes(2));
    expect(capture).toHaveBeenCalledTimes(1);
    first.resolve(result);
    await oldStart;
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect(mocks.arm).not.toHaveBeenCalled();
    second.resolve(result);
    await newStart;
    expect(mocks.arm).toHaveBeenCalledTimes(1);
    await h.runtime.stop();
  });
});
