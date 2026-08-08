import { useCallback, useEffect, useRef, useState } from 'react';
import { createVisionRuntime, MODELS } from '../vision/visionRuntime';
import type { CameraInfo, FrameInfo, VisionRuntime, VisionStatus } from '../vision/visionRuntime';
import type { MotionReport, MotionTile } from '../vision/motion';
import type { BoardTip } from '../../shared/vision/types';

/** How long a changed tile stays lit in the preview, and how many may be lit at once. */
const MOTION_TILE_MS = 450;
const MAX_MOTION_TILES = 64;
import { lensForCamera, loadSettings, saveSettings, setLensForCamera, type ScorerSettings } from '../lib/scorerStorage';

interface Options {
  /** Fires for every inference that solved a homography — an empty array is the takeout signal. */
  onTips: (tips: BoardTip[], ms: number) => void;
  onCameraActive: (active: boolean) => void;
}

/** `?e2e=1`, and only in a build that is allowed to have it. It must never ship enabled. */
function exposeForTests(): boolean {
  if (!import.meta.env.DEV && !import.meta.env.VITE_E2E) return false;
  return new URLSearchParams(window.location.search).get('e2e') === '1';
}

/**
 * Owns the vision runtime for the lifetime of the scoring page.
 *
 * The video ref comes back out rather than going in, because the runtime needs the element to read
 * pixels from and React owns when it exists. The motion gate's controls are ordinary React state:
 * it reports, this renders.
 *
 * (was: the refs come back out rather than going in, because the motion detector binds its five control
 * nodes once at construction: owning them here is what guarantees they exist, and that their
 * identity never changes underneath it.
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
  const [motionTiles, setMotionTiles] = useState<MotionTile[]>([]);

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
      onTiles: (tiles) => {
        // Flashes, not state: each batch is added and then expires on its own, so a tile that
        // keeps changing keeps flashing rather than staying lit.
        if (tiles.length === 0) { setMotionTiles([]); return; }
        setMotionTiles((current) => [...current, ...tiles].slice(-MAX_MOTION_TILES));
        const ids = new Set(tiles.map((tile) => tile.id));
        setTimeout(() => setMotionTiles((current) => current.filter((tile) => !ids.has(tile.id))), MOTION_TILE_MS);
      },
    });
    runtime.setModel(stored.model);
    runtime.setThresholds({ board: stored.boardThreshold, tip: stored.tipThreshold });
    runtimeRef.current = runtime;
    setReady(true);

    // The e2e seam. It replaces nothing in the pipeline — the model, the preprocessor, the
    // homography and the wire are all the real ones; a test just needs a way to ask for one
    // inference at a known moment instead of waiting on a motion gate it cannot control.
    if (exposeForTests()) {
      (window as unknown as { __scorer?: VisionRuntime }).__scorer = runtime;
    }

    return () => {
      runtimeRef.current = null;
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
      // The lens correction describes this particular lens, so it can only be applied once we know
      // which one opened.
      runtime.setLensCalibration(lensForCamera(loadSettings(), info.label));
      syncZoom();
      setCameraActive(true);
      onCameraActiveRef.current(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [syncZoom]);

  const stop = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    await runtime.stop();
    setZoomRange(null);
    setFrame(null);
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
    if (current) await start(current);
  }, [cameras, start, stop]);

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

  const setLens = useCallback((value: number) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setSettings(setLensForCamera(runtime.camera.label, value));
    runtime.setLensCalibration(value);
  }, []);

  return {
    refs: { video },
    motion,
    motionTiles,
    runtimeRef,
    frameRef,
    ready,
    cameras,
    cameraLabel,
    cameraActive,
    status,
    frame,
    settings,
    zoomRange,
    zoom,
    error,
    listCameras,
    start,
    stop,
    applyZoom,
    setModel,
    setThresholds,
    setLens,
  };
}
