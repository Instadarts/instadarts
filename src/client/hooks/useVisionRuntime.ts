import { useCallback, useEffect, useRef, useState } from 'react';
import { createVisionRuntime, MODELS } from '../vision/visionRuntime';
import type { CameraInfo, FrameInfo, VisionComputeOptions, VisionRuntime, VisionStatus } from '../vision/visionRuntime';
import type { MotionReport } from '../vision/motion';
import type { BoardTip } from '../../shared/vision/types';
import type { Region } from '../../shared/media';

/** How long changed tiles stay lit in the preview before fading out. */
const MOTION_TILE_MS = 450;

import { lensForCamera, loadSettings, saveSettings, setLensForCamera, type ScorerSettings } from '../lib/scorerStorage';

interface Options {
  /** Fires for every inference that solved a homography — an empty array is the takeout signal. */
  onTips: (tips: BoardTip[], ms: number) => void;
  /**
   * Whether a camera is open, and why not when a start was attempted and failed. The reason travels
   * because the person who asked for the camera may be looking at a different screen entirely.
   */
  onCameraActive: (active: boolean, error?: string) => void;
}

import { e2eEnabled } from '../lib/e2e';

/**
 * Owns the vision runtime for the lifetime of the scoring page.
 *
 * The video ref comes back out rather than going in, because the runtime needs the element to read
 * pixels from and React owns when it exists. The motion gate's controls are ordinary React state:
 * it reports, this renders.
 *
 * The runtime is built once and never rebuilt on a settings change. It has setters for everything
 * that can change at runtime, and tearing it down would mean reloading the model and restarting
 * the camera for the sake of a slider.
 */
export function useVisionRuntime({ onTips, onCameraActive }: Options) {
  const video = useRef<HTMLVideoElement>(null);

  const runtimeRef = useRef<VisionRuntime | null>(null);
  const [ready, setReady] = useState(false);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [cameraLabel, setCameraLabel] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [status, setStatus] = useState<VisionStatus | null>(null);
  const [frame, setFrame] = useState<FrameInfo | null>(null);
  const [settings, setSettings] = useState<ScorerSettings>(() => loadSettings());
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; step: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [motion, setMotion] = useState<MotionReport>(
    { armed: false, canArm: false, canTrigger: false, dot: 'idle', fps: null, mode: 'cpu' },
  );
  const [cameraResolution, setCameraResolution] = useState<string | null>(null);
  const [activeTiles, setActiveTiles] = useState<Set<number>>(new Set());
  const tileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Held in refs so the runtime, built once, always calls the current callbacks.
  const onTipsRef = useRef(onTips);
  onTipsRef.current = onTips;
  const onCameraActiveRef = useRef(onCameraActive);
  onCameraActiveRef.current = onCameraActive;
  /** Set by onFrame, which the runtime fires just before onTips. */
  const lastMs = useRef(0);
  /**
   * The last inference, readable synchronously. Calibration needs the keypoints immediately after
   * awaiting infer(), where the state update has not landed yet.
   */
  const frameRef = useRef<FrameInfo | null>(null);

  useEffect(() => {
    if (!video.current) return;

    const stored = loadSettings();
    const runtime = createVisionRuntime({
      video: video.current,
      // Publishing happens HERE and nowhere else. onFrame also fires for frames that produced no
      // homography, and reporting one of those as an empty tip list would read as a takeout and
      // submit the visit while the darts are still in the board.
      onTips: (tips) => onTipsRef.current(tips, lastMs.current),
      onStatus: (next) => {
        setStatus(next);
        if (next.stage === 'error') setError(next.text);
      },
      onFrame: (info) => {
        lastMs.current = Math.round(info.ms);
        frameRef.current = info;
        setFrame(info);
      },
      onReport: setMotion,
      onTiles: (indices) => {
        // Static grid: each tile index maps to one pre-rendered cell. Adding to the set lights it
        // up (CSS handles the visual); a single timer clears all tiles after the last batch.
        if (indices.length === 0) {
          setActiveTiles(new Set());
          if (tileTimerRef.current) { clearTimeout(tileTimerRef.current); tileTimerRef.current = null; }
          return;
        }
        setActiveTiles((prev) => {
          const next = new Set(prev);
          for (const i of indices) next.add(i);
          return next;
        });
        if (tileTimerRef.current) clearTimeout(tileTimerRef.current);
        tileTimerRef.current = setTimeout(() => setActiveTiles(new Set()), MOTION_TILE_MS);
      },
    });
    runtime.setModel(stored.model);
    runtime.setThresholds({ board: stored.boardThreshold, tip: stored.tipThreshold });
    runtime.setComputeOptions(stored);
    runtimeRef.current = runtime;
    setReady(true);

    // The e2e seam. It replaces nothing in the pipeline — the model, the preprocessor, the
    // homography and the wire are all the real ones; a test just needs a way to ask for one
    // inference at a known moment instead of waiting on a motion gate it cannot control.
    if (e2eEnabled()) {
      (window as unknown as { __scorer?: VisionRuntime }).__scorer = runtime;
    }

    return () => {
      runtimeRef.current = null;
      if (tileTimerRef.current) clearTimeout(tileTimerRef.current);
      delete (window as unknown as { __scorer?: VisionRuntime }).__scorer;
      void runtime.unload().catch(() => {});
    };
  }, []);

  const syncZoom = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const range = runtime.camera.zoomRange();
    setZoomRange(range);
    if (!range) return;
    const live = (runtime.camera.settings as { zoom?: number }).zoom;
    setZoom(Number(live ?? runtime.camera.storedZoom() ?? range.min));
  }, []);

  /** Enumerating cameras is what prompts for permission, so it is always user-initiated. */
  const listCameras = useCallback(async (): Promise<CameraInfo[]> => {
    const runtime = runtimeRef.current;
    if (!runtime) return [];
    try {
      const found = await runtime.listCameras();
      setCameras(found);
      setError(found.length === 0 ? 'No camera found — darts can still be entered by hand.' : null);
      return found;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    }
  }, []);

  const start = useCallback(async (deviceId: string) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setError(null);
    try {
      const info = await runtime.start(deviceId);
      setCameraLabel(info.label);
      setCameraResolution(runtime.cameraResolution);
      // The lens correction describes this particular lens, so it can only be applied once we know
      // which one opened.
      runtime.setLensCalibration(lensForCamera(loadSettings(), info.label));
      setCameraActive(true);
      onCameraActiveRef.current(true);
      // `runtime.start` has loaded LiteRT, received the camera's first frame, restored zoom and
      // armed motion detection. Prime the complete pipeline once now, without waiting for motion:
      // a mounted camera normally sees the board already, which gives evidence stills and director
      // commands their homography before the first dart and pays the unusually slow cold inference
      // while startup is still in progress.
      await runtime.infer();
      syncZoom();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onCameraActiveRef.current(false, message);
    }
  }, [syncZoom]);

  /**
   * Open whichever camera this device used last, without being told which.
   *
   * The single way in. The button, a match starting and the owner's remote switch all arrive here,
   * which is what stops them drifting into three slightly different ways to open a camera. Returns
   * whether one actually opened — a caller that told somebody else it would has to know.
   */
  const startPreferred = useCallback(async (): Promise<boolean> => {
    const runtime = runtimeRef.current;
    if (!runtime) return false;
    const found = await listCameras();
    if (found.length === 0) {
      // listCameras has already put the reason in `error`; it still has to travel, because a start
      // nobody sees fail is a start that looks like it worked.
      onCameraActiveRef.current(false, 'No camera available');
      return false;
    }
    const preferred = runtime.preferredCamera(found) ?? found[0];
    await start(preferred.deviceId);
    return runtime.camera.active;
  }, [listCameras, start]);

  const stop = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    await runtime.stop();
    setZoomRange(null);
    setFrame(null);
    setCameraResolution(null);
    setCameraActive(false);
    onCameraActiveRef.current(false);
  }, []);

  const applyZoom = useCallback(async (value: number) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setZoom(value);
    const applied = await runtime.camera.applyZoom(value);
    if (applied != null) setZoom(applied);
  }, []);

  /** Changing the model restarts the stream, because capture resolution follows its input size. */
  const setModel = useCallback(async (model: string) => {
    const runtime = runtimeRef.current;
    if (!runtime || !MODELS[model]) return;
    setSettings(saveSettings({ model }));
    runtime.setModel(model);
    if (!runtime.camera.active) return;
    const current = cameras.find((c) => c.label === runtime.camera.label)?.deviceId;
    await stop();
    // `startPreferred` rather than nothing when the lookup misses. It matches the open camera by
    // label against a list only `listCameras()` fills, so a page that never enumerated — or a
    // browser where the track's label and the device's differ — used to stop the camera here and
    // never bring it back, leaving a scoring device dark because somebody changed the model.
    if (current) await start(current);
    else await startPreferred();
  }, [cameras, start, startPreferred, stop]);

  const setThresholds = useCallback((next: { board?: number; tip?: number }) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const stored = saveSettings({
      ...(next.board !== undefined ? { boardThreshold: next.board } : {}),
      ...(next.tip !== undefined ? { tipThreshold: next.tip } : {}),
    });
    setSettings(stored);
    runtime.setThresholds({ board: stored.boardThreshold, tip: stored.tipThreshold });
  }, []);

  const setComputeOptions = useCallback((patch: Partial<VisionComputeOptions>): ScorerSettings => {
    const stored = saveSettings(patch);
    setSettings(stored);
    runtimeRef.current?.setComputeOptions(stored);
    return stored;
  }, []);

  const setLens = useCallback((value: number) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setSettings(setLensForCamera(runtime.camera.label, value));
    runtime.setLensCalibration(value);
  }, []);

  return {
    refs: { video },
    motion,
    activeTiles,
    runtimeRef,
    frameRef,
    ready,
    cameras,
    cameraLabel,
    cameraResolution,
    cameraActive,
    status,
    frame,
    settings,
    zoomRange,
    zoom,
    error,
    listCameras,
    start,
    startPreferred,
    stop,
    applyZoom,
    setModel,
    setThresholds,
    setComputeOptions,
    setLens,
    /**
     * Photograph a square of the board. Read through the ref rather than bound, because a still
     * request can arrive at any moment and must reach whatever runtime is current.
     */
    captureStill: (region: Region) => runtimeRef.current?.captureStill(region) ?? Promise.resolve(null),
    /** Whether the board has been located since the camera started. Lets a failed capture say why. */
    located: () => runtimeRef.current?.located ?? false,
    /** Point the live feed at a square of the board. Read through the ref for the same reason. */
    directVideo: (region: Region | null, transitionMs: number, resetMs: number) =>
      runtimeRef.current?.directVideo(region, transitionMs, resetMs),
    /** One frame of the live feed. The caller closes it — see VisionRuntime.grabVideoFrame. */
    grabVideoFrame: (size: number, timestampUs: number, durationUs: number) =>
      runtimeRef.current?.grabVideoFrame(size, timestampUs, durationUs) ?? null,
    /** The element the publisher paces against, where the platform lets it. */
    videoElement: () => video.current,
  };
}
