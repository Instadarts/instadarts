import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

/**
 * A camera that shows a photograph.
 *
 * `getUserMedia` is stubbed to return a real MediaStream from a canvas, so nothing downstream can
 * tell the difference: `camera.ts` gets a stream with real `videoWidth`/`videoHeight`, which both
 * the motion detector and the preprocessor structurally require. Substituting an `<img>` or a bare
 * canvas for the `<video>` element would not work.
 *
 * Not to be confused with the *virtual camera* in `vision/videoCamera.ts`, which is a real feature —
 * the framing a director moves over an outgoing video feed. This is a test double.
 *
 * Everything after the camera is the real thing — the model, the WebGPU/WASM preprocessor, the
 * postprocessor, the homography, the wire, the server's fusion and the visit logic.
 */
export interface FakeCameraOptions {
  /** Cap the actual stream independently of the caller's ideal constraints, as real cameras do. */
  maxWidth?: number;
  maxHeight?: number;
}

export async function installFakeCamera(
  page: Page,
  scenes: Record<string, string>,
  options: FakeCameraOptions = {},
): Promise<void> {
  const encoded: Record<string, string> = {};
  for (const [name, file] of Object.entries(scenes)) {
    encoded[name] = `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;
  }

  await page.addInitScript(({ images, options }: {
    images: Record<string, string>;
    options: FakeCameraOptions;
  }) => {
    /** What a caller gets for asking for nothing, and the smaller model's input size. */
    const DEFAULT_SIZE = 960;

    // One canvas per actual mode returned. By default the fake honours the requested square. A test
    // can cap either axis to imitate hardware that ignores the square ideal — notably a 1280x720
    // camera when the scorer asks for 960x960 or 1280x1280.
    interface FakeCanvas {
      ctx: CanvasRenderingContext2D;
      tracks: Set<CanvasCaptureMediaStreamTrack>;
    }
    const canvases = new Map<string, FakeCanvas>();
    const fakeTrackIds = new Set<string>();

    function canvasFor(width: number, height: number): FakeCanvas {
      const key = `${width}x${height}`;
      let state = canvases.get(key);
      if (!state) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        state = { ctx, tracks: new Set() };
        canvases.set(key, state);
      }
      return state;
    }

    const loaded = new Map<string, Promise<HTMLImageElement>>();

    function imageFor(name: string): Promise<HTMLImageElement> {
      let pending = loaded.get(name);
      if (!pending) {
        pending = (async () => {
          const image = new Image();
          image.src = images[name];
          await image.decode();
          return image;
        })();
        loaded.set(name, pending);
      }
      return pending;
    }

    let current = Object.keys(images)[0];
    let revision = 0;
    let painting: Promise<void> = Promise.resolve();
    let changingScene = false;

    async function paint(name: string, expectedRevision: number): Promise<void> {
      const image = await imageFor(name);
      // An older decode must never land after a newer scene was selected. This was the source of
      // intermittent "darts disappeared back into an empty board" failures under load.
      if (revision !== expectedRevision || current !== name) return;
      for (const { ctx, tracks } of canvases.values()) {
        // The source scene is square. Put that whole scene in the stream's centre square and leave
        // the excess landscape/portrait area black. A correct centre crop recovers the exact scene;
        // stretching the source across the fake stream would conceal an aspect-ratio bug.
        const size = Math.min(ctx.canvas.width, ctx.canvas.height);
        const x = Math.floor((ctx.canvas.width - size) / 2);
        const y = Math.floor((ctx.canvas.height - size) / 2);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.drawImage(image, x, y, size, size);
        for (const track of tracks) track.requestFrame();
      }
    }

    function queuePaint(): Promise<void> {
      const name = current;
      const expectedRevision = revision;
      painting = painting.then(() => paint(name, expectedRevision));
      return painting;
    }

    // A zero-rate canvas stream emits exactly when requestFrame() is called. Keeping that clock here
    // makes the fake independent of scheduler load and lets a scene change await the actual video
    // frame instead of sleeping for an assumed number of capture intervals.
    setInterval(() => {
      if (!changingScene) void queuePaint();
    }, 100);

    const fakeDevice = { deviceId: 'fake-camera', kind: 'videoinput', label: 'Fake board camera', groupId: 'fake' };

    function requestedValue(
      constraint: ConstrainULong | undefined,
      fallback: number,
    ): number {
      if (typeof constraint === 'number') return constraint;
      if (constraint && typeof constraint === 'object') {
        const wanted = constraint.ideal ?? constraint.exact;
        if (typeof wanted === 'number') return wanted;
      }
      return fallback;
    }

    /** The actual mode returned after applying this fake device's hardware caps. */
    function requestedDimensions(constraints?: MediaStreamConstraints): { width: number; height: number } {
      const video = constraints?.video;
      const requestedWidth = !video || typeof video === 'boolean'
        ? DEFAULT_SIZE
        : requestedValue(video.width, DEFAULT_SIZE);
      const requestedHeight = !video || typeof video === 'boolean'
        ? DEFAULT_SIZE
        : requestedValue(video.height, DEFAULT_SIZE);
      return {
        width: Math.min(requestedWidth, options.maxWidth ?? requestedWidth),
        height: Math.min(requestedHeight, options.maxHeight ?? requestedHeight),
      };
    }

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        // A fresh stream per call, exactly as the real one gives. Handing out a shared stream would
        // mean the permission probe in listCameras() stops the track the camera then tries to use.
        getUserMedia: async (constraints?: MediaStreamConstraints) => {
          const { width, height } = requestedDimensions(constraints);
          const state = canvasFor(width, height);
          // Painted before it is captured, so the first frame off a newly sized canvas is the scene
          // rather than the black it was cleared to.
          await queuePaint();
          const stream = state.ctx.canvas.captureStream(0);
          // A canvas track calls itself a random string; a real camera track calls itself what
          // `enumerateDevices` calls the device. That agreement is load-bearing — every per-camera
          // setting, and the remembered choice itself, is keyed by the track's label and matched
          // against the enumerated one — so the double has to imitate it or nothing round-trips.
          for (const track of stream.getVideoTracks()) {
            Object.defineProperty(track, 'label', { value: fakeDevice.label, configurable: true });
            if (options.maxWidth && options.maxHeight) {
              const getCapabilities = track.getCapabilities?.bind(track);
              Object.defineProperty(track, 'getCapabilities', {
                configurable: true,
                value: () => ({
                  ...(getCapabilities?.() ?? {}),
                  width: { min: 1, max: options.maxWidth },
                  height: { min: 1, max: options.maxHeight },
                }),
              });
            }
            const canvasTrack = track as CanvasCaptureMediaStreamTrack;
            state.tracks.add(canvasTrack);
            fakeTrackIds.add(track.id);
            track.addEventListener('ended', () => state.tracks.delete(canvasTrack), { once: true });
            canvasTrack.requestFrame();
          }
          return stream;
        },
        enumerateDevices: async () => [fakeDevice],
        getSupportedConstraints: () => ({}),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });

    (window as unknown as { __scene: (name: string) => Promise<void> }).__scene = async (name: string) => {
      if (!(name in images)) throw new Error(`unknown fake-camera scene: ${name}`);
      changingScene = true;
      try {
        current = name;
        revision += 1;
        await imageFor(name);
        await painting; // every older paint now observes the new revision and becomes a no-op

        const videos = [...document.querySelectorAll('video')].filter((video) => {
          const stream = video.srcObject;
          return stream instanceof MediaStream && stream.getVideoTracks().some((track) => fakeTrackIds.has(track.id));
        });
        const present = async () => {
          const nextFrames = videos.map((video) => new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('fake camera frame did not reach its video element')), 5000);
            video.requestVideoFrameCallback(() => {
              clearTimeout(timeout);
              resolve();
            });
          }));
          await queuePaint();
          await Promise.all(nextFrames);
        };
        // The second presented frame is ordered after the first callback, so even a frame queued
        // just before the scene switch cannot satisfy the wait with the old picture.
        await present();
        await present();
      } finally {
        changingScene = false;
      }
    };

    void queuePaint();
  }, { images: encoded, options });
}

/** Run one inference on whatever the fake camera is currently showing. */
export async function scan(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const runtime = (window as unknown as { __scorer?: { infer: () => Promise<unknown> } }).__scorer;
    if (!runtime) throw new Error('vision runtime not exposed — is ?e2e=1 set?');
    await runtime.infer();
  });
}

export async function showScene(page: Page, name: string): Promise<void> {
  await page.evaluate((scene) => (window as unknown as { __scene: (n: string) => Promise<void> }).__scene(scene), name);
}
