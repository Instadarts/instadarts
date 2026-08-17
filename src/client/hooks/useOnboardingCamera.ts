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

import { useCallback, useMemo, useRef, useState } from 'react';
import { createCamera, listCameras, preferredCamera, type Camera, type CameraChoice, type ZoomRange } from '../vision/camera';
import { MODELS } from '../vision/visionRuntime';
import { loadSettings } from '../lib/scorerStorage';

/**
 * What the self-test needs from the camera, and nothing else.
 *
 * The requested capture size follows the model, although real cameras may return a smaller or
 * landscape mode. The shared preprocessing crop handles that; this handle only lets benchmarking
 * request the best stream the camera can provide for each model.
 */
export interface OnboardingCamera {
  video: HTMLVideoElement;
  /** Re-open with this preferred size unless it was already requested. Resolves on a real frame. */
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

  /**
   * What the self-test and the live preview run against.
   *
   * **Stable by identity, and that is load bearing.** It is an effect dependency on the other side,
   * so a fresh object per render is a model unloaded and recompiled per render — which is exactly
   * what it was, and what made the preview stutter: forty-one compiles in five seconds where one
   * was wanted. It is rebuilt only when a different camera actually opens.
   */
  const handle = useMemo<OnboardingCamera | null>(() => {
    const video = videoRef.current;
    if (phase !== 'ready' || !video) return null;
    return {
      video,
      ensureInputSize: async (inputSize: number) => {
        if (openedAt.current === inputSize) return;
        await open(deviceId.current, inputSize);
      },
    };
  }, [phase, open]);

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
