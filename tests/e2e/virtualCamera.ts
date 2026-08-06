import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

/**
 * A camera that shows a photograph.
 *
 * `getUserMedia` is stubbed to return a real MediaStream from a canvas, so nothing downstream can
 * tell the difference: `camera.js` gets a stream with real `videoWidth`/`videoHeight`, which both
 * the motion detector and the preprocessor structurally require. Substituting an `<img>` or a bare
 * canvas for the `<video>` element would not work.
 *
 * Everything after the camera is the real thing — the model, the WebGPU/WASM preprocessor, the
 * postprocessor, the homography, the wire, the server's fusion and the visit logic.
 */
export async function installVirtualCamera(page: Page, scenes: Record<string, string>): Promise<void> {
  const encoded: Record<string, string> = {};
  for (const [name, file] of Object.entries(scenes)) {
    encoded[name] = `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;
  }

  await page.addInitScript((images: Record<string, string>) => {
    const SIZE = 960;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);

    const loaded = new Map<string, HTMLImageElement>();

    async function draw(name: string): Promise<void> {
      let image = loaded.get(name);
      if (!image) {
        image = new Image();
        image.src = images[name];
        await image.decode();
        loaded.set(name, image);
      }
      ctx.drawImage(image, 0, 0, SIZE, SIZE);
    }

    // captureStream only emits a frame when the canvas is painted, so keep painting: the video
    // element needs a steady stream to report dimensions and to keep playing.
    let current = Object.keys(images)[0];
    setInterval(() => void draw(current), 100);

    const fakeDevice = { deviceId: 'virtual-camera', kind: 'videoinput', label: 'Virtual board camera', groupId: 'virtual' };
    const capture = () => (canvas as HTMLCanvasElement & { captureStream(fps: number): MediaStream }).captureStream(15);

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        // A fresh stream per call, exactly as the real one gives. Handing out a shared stream would
        // mean the permission probe in listCameras() stops the track the camera then tries to use.
        getUserMedia: async () => capture(),
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

/** Run one inference on whatever the virtual camera is currently showing. */
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
