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
export async function installFakeCamera(page: Page, scenes: Record<string, string>): Promise<void> {
  const encoded: Record<string, string> = {};
  for (const [name, file] of Object.entries(scenes)) {
    encoded[name] = `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;
  }

  await page.addInitScript((images: Record<string, string>) => {
    /** What a caller gets for asking for nothing, and the smaller model's input size. */
    const DEFAULT_SIZE = 960;

    // One canvas per size asked for, because capture resolution is a thing under test: the scorer
    // opens the camera square at the model's input size and re-opens it when the model changes, so a
    // fake fixed at one size would let a benchmark of the 1280 px model quietly run on 960 px
    // frames. Real hardware may of course answer with something else entirely; this honours the
    // common case, which is what makes the change observable at all.
    const canvases = new Map<number, CanvasRenderingContext2D>();

    function contextFor(size: number): CanvasRenderingContext2D {
      let ctx = canvases.get(size);
      if (!ctx) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, size, size);
        canvases.set(size, ctx);
      }
      return ctx;
    }

    const loaded = new Map<string, HTMLImageElement>();

    async function draw(name: string): Promise<void> {
      let image = loaded.get(name);
      if (!image) {
        image = new Image();
        image.src = images[name];
        await image.decode();
        loaded.set(name, image);
      }
      for (const ctx of canvases.values()) {
        ctx.drawImage(image, 0, 0, ctx.canvas.width, ctx.canvas.height);
      }
    }

    // captureStream only emits a frame when the canvas is painted, so keep painting: the video
    // element needs a steady stream to report dimensions and to keep playing.
    let current = Object.keys(images)[0];
    setInterval(() => void draw(current), 100);

    const fakeDevice = { deviceId: 'fake-camera', kind: 'videoinput', label: 'Fake board camera', groupId: 'fake' };

    /** The square the caller asked for, as `camera.ts` asks for it. */
    function requestedSize(constraints?: MediaStreamConstraints): number {
      const video = constraints?.video;
      if (!video || typeof video === 'boolean') return DEFAULT_SIZE;
      const width = video.width;
      const wanted = typeof width === 'object' ? (width.ideal ?? width.exact) : width;
      return typeof wanted === 'number' ? wanted : DEFAULT_SIZE;
    }

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        // A fresh stream per call, exactly as the real one gives. Handing out a shared stream would
        // mean the permission probe in listCameras() stops the track the camera then tries to use.
        getUserMedia: async (constraints?: MediaStreamConstraints) => {
          const ctx = contextFor(requestedSize(constraints));
          // Painted before it is captured, so the first frame off a newly sized canvas is the scene
          // rather than the black it was cleared to.
          await draw(current);
          const stream = (ctx.canvas as HTMLCanvasElement & { captureStream(fps: number): MediaStream }).captureStream(15);
          // A canvas track calls itself a random string; a real camera track calls itself what
          // `enumerateDevices` calls the device. That agreement is load-bearing — every per-camera
          // setting, and the remembered choice itself, is keyed by the track's label and matched
          // against the enumerated one — so the double has to imitate it or nothing round-trips.
          for (const track of stream.getVideoTracks()) {
            Object.defineProperty(track, 'label', { value: fakeDevice.label, configurable: true });
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
      current = name;
      await draw(name);
      // Let a few frames of the new scene reach the video element before anyone looks at it.
      await new Promise((resolve) => setTimeout(resolve, 400));
    };

    void draw(current);
  }, encoded);
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
