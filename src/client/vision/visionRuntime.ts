// The camera device's pipeline: camera → motion gate → inference → postprocess → geometry, and it
// stops there. What it emits is board-plane dart tips — lens-corrected, projected and clamped into
// instadarts board coordinates.
//
// **It deliberately does not score.** Geometry is local to the lens that produced it: the
// calibration, the zoom and the mount all describe one physical camera. Fusion and scoring are the
// server's, so that two cameras seeing one dart produce one number rather than two. The cut is
// exactly where the coordinate stops being about a lens and starts being about a board.
//
// Heavily tuned for phone performance — motion gating, frame pacing, tensor reuse, the WebGPU/WASM
// fallback chain. Do not "clean up" without a benchmark on a real device.

import { getCenterSquareCrop, loadModel, unloadModel, type ModelRunner } from './model';
import { postprocess } from './postprocess';
import { createMotionDetector, type MotionDetector, type MotionReport, type MotionTile } from './motion';
import { createCamera, listCameras, preferredCamera, type Camera, type CameraChoice } from './camera';
import { processPredictions, type PipelineResult } from './predictionPipeline';
import { DEFAULT_BOARD_THRESHOLD, DEFAULT_TIP_THRESHOLD } from '../../shared/vision/constants';
import type { BoardTip, Keypoint } from '../../shared/vision/types';

export type VisionStatus = {
  stage: 'model' | 'camera' | 'motion' | 'error';
  text: string;
};

export type FrameInfo = {
  keypoints: Keypoint[];
  result: PipelineResult | null;
  ms: number;
  accelerator: string;
};

export type CameraInfo = CameraChoice;

export interface VisionRuntimeOptions {
  video: HTMLVideoElement;
  /**
   * Fires on every inference that produced a homography, including ones that found no tips at
   * all — an empty array is the takeout signal. A frame with no homography fires nothing, because
   * "the board is not visible" is not "the board is empty".
   */
  onTips: (tips: BoardTip[]) => void;
  onStatus?: (status: VisionStatus) => void;
  onFrame?: (frame: FrameInfo) => void;
  /** What the motion gate is doing, for whoever draws it. */
  onReport?: (report: MotionReport) => void;
  onTiles?: (tiles: MotionTile[]) => void;
}

export interface VisionRuntime {
  listCameras: () => Promise<CameraInfo[]>;
  camera: Camera;
  motion: MotionDetector;
  preferredCamera: (cameras: CameraInfo[]) => CameraInfo | null;
  infer: () => Promise<BoardTip[]>;
  start: (deviceId: string) => Promise<{ label: string; settings: MediaTrackSettings }>;
  stop: () => Promise<void>;
  unload: () => Promise<void>;
  setModel: (key: string) => void;
  setLensCalibration: (value: number) => void;
  readonly lensCalibration: number;
  setThresholds: (thresholds: { board?: number; tip?: number }) => void;
  readonly modelKey: string;
  /** Side of the square the model is fed — the space keypoints are normalised in. */
  readonly inputSize: number;
  /** Keep a copy of each inference's input square, for the frozen calibration frame. */
  setKeepInputFrame: (on: boolean) => void;
  /** Paint that copy into a 2D context; false when no frame has been kept yet. */
  drawInputFrame: (targetCtx: CanvasRenderingContext2D, size: number) => boolean;
}

export const MODELS: Record<string, { url: string; inputSize: number }> = {
  s_960: { url: '/models/s_960.tflite', inputSize: 960 },
  s_1280: { url: '/models/s_1280.tflite', inputSize: 1280 },
};

export function createVisionRuntime({ video, onTips, onStatus = () => {}, onFrame = () => {}, onReport, onTiles }: VisionRuntimeOptions): VisionRuntime {
  const camera = createCamera({ video });
  let model: ModelRunner | null = null;
  let modelKey = 's_960';
  let lensCalibration = 0;
  let boardThreshold = DEFAULT_BOARD_THRESHOLD;
  let tipThreshold = DEFAULT_TIP_THRESHOLD;
  let busy = false;

  // Lens calibration works on a frozen frame: the phone is hand-held while the slider is dragged,
  // and an overlay drawn over a live picture would move with every wobble. So the exact square the
  // model was fed is kept, drawn here rather than read back from the preprocessing canvas — the
  // WebGPU path never populates that (model.js:215).
  let keepInputFrame = false;
  let inputFrame: HTMLCanvasElement | null = null;

  function captureInputFrame() {
    if (!keepInputFrame) return;
    const size = inputSize();
    if (!inputFrame) inputFrame = document.createElement('canvas');
    if (inputFrame.width !== size) { inputFrame.width = size; inputFrame.height = size; }
    try {
      const { cropX, cropY, cropSize } = getCenterSquareCrop(video);
      inputFrame.getContext('2d')!.drawImage(video, cropX, cropY, cropSize, cropSize, 0, 0, size, size);
    } catch {
      // Frame not ready yet; the next inference brings another one.
    }
  }

  const inputSize = () => MODELS[modelKey].inputSize;

  async function ensureModel() {
    if (model) return model;
    onStatus({ stage: 'model', text: `loading ${modelKey}…` });
    model = await loadModel(MODELS[modelKey].url, 'webgpu');
    onStatus({ stage: 'model', text: `model ${modelKey} on ${model.accelerator || 'cpu'}` });
    return model;
  }

  /** One inference pass over the current frame. Returns the board-plane tips it found. */
  async function infer() {
    if (busy || !camera.active) return [];
    busy = true;
    const startedAt = performance.now();
    try {
      const runner = await ensureModel();
      captureInputFrame();
      const { outputs } = await runner.run(video, inputSize(), {});
      if (!outputs || outputs.length < 2) return [];

      // outputs[0] = single [1, 10, N], outputs[1] = multi [1, 3, N]
      const predictions = postprocess(outputs[0], outputs[1], inputSize());
      const keypoints = predictions[0];

      // Threshold filter → dedup → undistort → homography → project tips to board space.
      const result = processPredictions(keypoints, boardThreshold, tipThreshold, lensCalibration);
      onFrame({
        keypoints,
        result,
        ms: performance.now() - startedAt,
        accelerator: runner.accelerator || 'cpu',
      });
      // No homography means the board was not visible enough to say where anything is — which is
      // NOT an empty board. Reporting it as one would read as a takeout and submit the visit
      // while the darts are still in it, so nothing is published for such a frame.
      if (!result) return [];

      const tips = result.tips.map((tip) => ({ x: tip.x, y: tip.y, confidence: tip.confidence }));
      // Published on EVERY inference that solved a homography, including ones that found nothing:
      // an empty array is how the server learns the darts came out. The server, not this device,
      // decides which of these tips are new.
      onTips(tips);
      return tips;
    } catch (err) {
      onStatus({ stage: 'error', text: err instanceof Error ? err.message : String(err) });
      return [];
    } finally {
      busy = false;
    }
  }

  const motion = createMotionDetector({
    preview: video,
    canArm: () => camera.active,
    canTrigger: () => camera.active,
    isTriggerBusy: () => busy,
    onTrigger: () => { void infer(); },
    onArmedChange: (armed) => onStatus({ stage: 'motion', text: armed ? 'watching' : 'idle' }),
    onReport,
    onTiles,
  });

  return {
    listCameras,
    preferredCamera,
    camera,
    motion,
    infer,

    async start(deviceId) {
      await ensureModel();
      const info = await camera.start(deviceId, inputSize());
      const saved = camera.storedZoom();
      if (saved != null) await camera.applyZoom(saved).catch(() => {});
      motion.arm();
      onStatus({ stage: 'camera', text: `${info.label} ${info.settings.width}×${info.settings.height}` });
      return info;
    },

    async stop() {
      motion.reset();
      camera.stop();
      onStatus({ stage: 'camera', text: 'stopped' });
    },

    async unload() {
      await this.stop();
      await unloadModel();
      model = null;
    },

    // There is deliberately no resetVisit() or trackedDarts here: a camera device is stateless
    // about darts (server/scoring/tracker.ts owns that), which is exactly what lets a second
    // camera join mid-visit with nothing to reconcile.

    setModel(key: string) { if (MODELS[key] && key !== modelKey) { modelKey = key; model = null; } },
    setLensCalibration(value: number) { lensCalibration = Number(value) || 0; },
    get lensCalibration() { return lensCalibration; },
    setThresholds({ board, tip }: { board?: number; tip?: number }) {
      if (typeof board === 'number' && Number.isFinite(board)) boardThreshold = board;
      if (typeof tip === 'number' && Number.isFinite(tip)) tipThreshold = tip;
    },
    get modelKey() { return modelKey; },
    get inputSize() { return inputSize(); },

    /** Keep a copy of each inference's input square (calibration only — it costs a full draw). */
    setKeepInputFrame(on: boolean) {
      keepInputFrame = Boolean(on);
      if (!keepInputFrame) inputFrame = null;
    },
    /** Paint the last kept input square into a 2D context. False when there is nothing to show. */
    drawInputFrame(targetCtx: CanvasRenderingContext2D, size: number) {
      if (!inputFrame) return false;
      targetCtx.drawImage(inputFrame, 0, 0, size, size);
      return true;
    },
  };
}
