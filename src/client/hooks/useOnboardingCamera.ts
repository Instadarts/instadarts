// The camera, during setup: asking for it, choosing one, and framing it.
//
// **Deliberately not the vision runtime.** `visionRuntime.start()` arms the motion gate, and an
// armed gate runs inferences through the model singleton that the self-test is loading and
// unloading underneath it — competing for the same object and burning CPU inside the measurements.
// So setup drives `vision/camera.ts` directly, against a `<video>` element of its own, while
// `ScorerPage` keeps the runtime's camera shut (see its `startCamera` guard).
//
// It lives in a hook rather than in the step that shows it because the camera outlives that step:
// the benchmark that follows runs through the very stream chosen here.

import { useCallback, useRef, useState } from 'react';
import { createCamera, listCameras, preferredCamera, type Camera, type CameraChoice, type ZoomRange } from '../vision/camera';
import { MODELS } from '../vision/visionRuntime';
import { loadSettings } from '../lib/scorerStorage';

/**
 * What the self-test needs from the camera, and nothing else.
 *
 * Capture is square at the model's input size, so a bigger model needs a bigger stream — the same
 * coupling the scoring screen has. Handing the harness this much means it can honour that without
 * knowing anything about permissions, pickers or zoom.
 */
export interface OnboardingCamera {
  video: HTMLVideoElement;
  /** Re-open at this capture size unless already open at it. Resolves once a frame has arrived. */
  ensureInputSize(inputSize: number): Promise<void>;
}

export type CameraPhase = 'checking' | 'ask' | 'opening' | 'ready' | 'failed';

export function useOnboardingCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraRef = useRef<Camera | null>(null);
  const deviceId = useRef('');
  /** What capture size the open stream was asked for, so a restart can be skipped. */
  const openedAt = useRef(0);

  const [phase, setPhase] = useState<CameraPhase>('checking');
  const [cameras, setCameras] = useState<CameraChoice[]>([]);
  const [selected, setSelected] = useState('');
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null);
  const [zoom, setZoom] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const camera = () => {
    const video = videoRef.current;
    if (!video) throw new Error('The preview is not on screen yet.');
    if (!cameraRef.current) cameraRef.current = createCamera({ video });
    return cameraRef.current;
  };

  /** Open one camera and settle the controls that describe it. Every start goes through here. */
  const open = useCallback(async (id: string, inputSize: number) => {
    const handle = camera();
    await handle.start(id, inputSize);
    await firstFrame(videoRef.current!);
    deviceId.current = id;
    openedAt.current = inputSize;

    // Re-applied on every start, including a restart for the larger model: constraints do not
    // survive the track they were applied to, and the framing should not change under somebody.
    const range = handle.zoomRange();
    setZoomRange(range);
    const stored = handle.storedZoom();
    if (range && stored != null) await handle.applyZoom(stored).catch(() => {});
    setZoom(stored ?? (Number(handle.settings.zoom) || range?.min || 0));
  }, []);

  /** Ask for the camera, list what there is, and open the one this phone would prefer. */
  const ask = useCallback(async () => {
    setPhase('opening');
    setError(null);
    try {
      // `listCameras` probes with getUserMedia first — labels are empty until access is granted
      // once — so this call is both the permission request and the enumeration.
      const found = await listCameras();
      setCameras(found);
      const choice = preferredCamera(found);
      if (!choice) throw new DOMException('no video input', 'NotFoundError');
      setSelected(choice.deviceId);
      await open(choice.deviceId, MODELS[loadSettings().model].inputSize);
      setPhase('ready');
    } catch (e) {
      setError(describe(e));
      setPhase('failed');
    }
  }, [open]);

  /**
   * Decide whether to prompt or just go.
   *
   * A phone that has been here before should not be asked again, and a phone that has not should
   * see a button rather than a permission dialog it did not ask for. Where the Permissions API does
   * not answer for cameras — Safari — the button is the honest fallback.
   */
  const begin = useCallback(async () => {
    let granted = false;
    try {
      const status = await navigator.permissions?.query({ name: 'camera' as PermissionName });
      granted = status?.state === 'granted';
    } catch {
      // Safari, and anything else that will not answer. Ask by pressing.
    }
    if (granted) await ask();
    else setPhase('ask');
  }, [ask]);

  const choose = useCallback(async (id: string) => {
    setSelected(id);
    setPhase('opening');
    try {
      await open(id, MODELS[loadSettings().model].inputSize);
      setPhase('ready');
    } catch (e) {
      setError(describe(e));
      setPhase('failed');
    }
  }, [open]);

  const applyZoom = useCallback(async (value: number) => {
    setZoom(value);
    const clamped = await camera().applyZoom(value);
    if (clamped != null) setZoom(clamped);
  }, []);

  const handle = useCallback((): OnboardingCamera | null => {
    const video = videoRef.current;
    if (!video || !cameraRef.current?.active) return null;
    return {
      video,
      ensureInputSize: async (inputSize: number) => {
        if (openedAt.current === inputSize) return;
        await open(deviceId.current, inputSize);
      },
    };
  }, [open]);

  const dispose = useCallback(() => {
    cameraRef.current?.stop();
    openedAt.current = 0;
  }, []);

  return { videoRef, phase, cameras, selected, zoomRange, zoom, error, begin, ask, choose, applyZoom, handle, dispose };
}

/** Why this device cannot do it, in a sentence rather than a DOMException name. */
function describe(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'This browser is not letting the page use the camera. Allow camera access for this site, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this device. A scoring device needs one to watch the board.';
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wait until the element actually has a picture in it.
 *
 * `play()` resolving is not the same thing: it says the element started, not that a frame arrived.
 * That matters twice — the motion gate refuses a preview with no dimensions, and an inference timed
 * against a blank frame is not a measurement. The timeout turns a stream that never produces
 * anything into a message rather than a screen that sits there.
 */
function firstFrame(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('The camera opened but sent no picture.'));
    }, 5000);
    const done = () => {
      if (video.videoWidth === 0) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('timeupdate', done);
    };
    video.addEventListener('loadedmetadata', done);
    video.addEventListener('timeupdate', done);
  });
}
