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
import type { BoardTip, Keypoint, Matrix3x3 } from '../../shared/vision/types';
import type { Region } from '../../shared/media';
import { DEFAULT_REGION, STILL, clampRegion } from '../../shared/media';
import { captureCrop, frameGeometry, regionToCrop, type Capture, type CropRect } from './stillCapture';
import { createVirtualCamera, grabFrame, releaseCanvas } from './videoCamera';

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
  /**
   * Photograph a square of the board, as a still request asks for.
   *
   * Null when there is nothing to answer with: no camera running, or the board has not been located
   * since it started. Both are honest answers — a crop this device could not place is not evidence
   * of anything, and a picture of the wrong part of the board is worse than no picture.
   */
  captureStill: (region: Region) => Promise<Capture | null>;
  /**
   * Point the live feed at a square of the board, taking `transitionMs` to get there, and come back
   * `resetMs` after being told. `resetMs: 0` stays.
   *
   * `null` is "no direction" and means the whole board — what a reset goes back to, and what a caller
   * passes to release the camera by hand. Unlike a still there is no failure to report: a region that
   * cannot be placed — no homography yet, or one that will not invert — falls back to the camera's
   * own square rather than refusing, because a feed that shows something honest beats a feed that
   * shows nothing.
   */
  directVideo: (region: Region | null, transitionMs: number, resetMs: number) => void;
  /**
   * One frame of the live feed, framed as the director last asked. Null when there is no camera.
   *
   * **The caller must close it.** A `VideoFrame` holds a real buffer, often a GPU texture, and
   * leaking them stalls an encoder in a second or two rather than degrading gently.
   */
  grabVideoFrame: (size: number, timestampUs: number, durationUs: number) => VideoFrame | null;
  /** Whether the board has been located since the camera started, so a region can be placed at all. */
  readonly located: boolean;
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
  /**
   * The last homography this camera solved, kept so a still can be framed from a moment when the
   * board did not happen to resolve.
   *
   * A mounted camera stands still, so yesterday's answer is almost always today's — and the cost of
   * insisting on a fresh one is losing the evidence for a dart because a hand was in the way. It is
   * dropped in `stop()`, so it can never outlive the camera session that produced it. (A maximum age
   * would be the next refinement, and is deliberately not here.)
   */
  let lastHomography: Matrix3x3 | null = null;

  /**
   * The live feed's framing. Holds only the animation — where the shot is going is re-resolved on
   * every frame by `videoDestination` below, which is what lets a feed that started before the board
   * was found slide onto it the moment it is.
   */
  const virtualCamera = createVirtualCamera();
  let videoRegion: Region | null = null;
  /** The pending return to the default shot. See `directVideo`. */
  let videoResetTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelVideoReset(): void {
    if (videoResetTimer) clearTimeout(videoResetTimer);
    videoResetTimer = null;
  }

  /**
   * Where the feed should be pointed right now, in this camera's own pixels.
   *
   * Two answers, and the fallback is the point of it. With a homography, the region is placed on the
   * board exactly as a still's would be — same inverse, same lens, same bounding square. Without one,
   * the camera's own centre square: the square the model is fed, which needs no geometry at all and
   * is available the instant the camera is. So a feed never waits for the board and never lies about
   * where it is looking.
   */
  function videoDestination(): CropRect | null {
    if (!video.videoWidth || !video.videoHeight) return null;
    const { crop, frame } = frameGeometry(video);

    if (lastHomography) {
      const rect = regionToCrop({
        region: clampRegion(videoRegion ?? DEFAULT_REGION),
        homography: lastHomography,
        lensCalibration,
        crop,
        frame,
      });
      if (rect) return rect;
    }
    return { x: crop.cropX, y: crop.cropY, size: crop.cropSize };
  }

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
      lastHomography = result.homography;

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
    onArmedChange: (armed) => onStatus({ stage: 'motion', text: armed ? 'scanning automatically' : 'idle' }),
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
      // The camera goes first. `motion.reset()` publishes what the controls should look like, and
      // what it publishes for `canArm` is "is there a camera" — so resetting first announced one
      // that was still open, and the automatic-scan button sat there live and green with nothing
      // left to scan.
      camera.stop();
      motion.reset();
      // The homography described where a board was in *that* camera session's frames. Kept across
      // one, it would frame a still from a picture that no longer exists.
      lastHomography = null;
      // Same reasoning for the shot: a phone that is picked up and re-aimed between sessions should
      // open on its new view, not slide there from where the old one was pointing. The *region*
      // survives, because that is the director's instruction and it is about the board rather than
      // about any camera — but the timer that would release it must not, or it fires into a camera
      // session that knows nothing about the command that set it.
      virtualCamera.reset();
      cancelVideoReset();
      releaseCanvas();
      onStatus({ stage: 'camera', text: 'stopped' });
    },

    get located() { return lastHomography !== null; },

    async captureStill(region: Region) {
      if (!camera.active || !lastHomography) return null;
      if (!video.videoWidth || !video.videoHeight) return null;

      const { crop, frame } = frameGeometry(video);
      const rect = regionToCrop({
        region: clampRegion(region),
        homography: lastHomography,
        lensCalibration,
        crop,
        frame,
      });
      if (!rect) return null;
      return captureCrop(video, rect, STILL.size, STILL.mime, STILL.quality);
    },

    directVideo(region: Region | null, transitionMs: number, resetMs: number) {
      // Any command cancels the one before it, including a reset that has not fired yet. The move
      // itself departs from wherever the shot currently is, so interrupting a transition half way
      // through swings on from there rather than jumping back to start again.
      cancelVideoReset();
      videoRegion = region;
      virtualCamera.move(transitionMs);

      // A release needs no release of its own — it is already the resting shot.
      if (!region || resetMs <= 0) return;
      videoResetTimer = setTimeout(() => {
        videoResetTimer = null;
        videoRegion = null;
        // The same transition back out. A shot that eased in and snapped out reads as a glitch.
        virtualCamera.move(transitionMs);
      }, resetMs);
    },

    grabVideoFrame(size: number, timestampUs: number, durationUs: number) {
      if (!camera.active) return null;
      const destination = videoDestination();
      if (!destination) return null;
      return grabFrame(video, virtualCamera.shot(destination, performance.now()), size, timestampUs, durationUs);
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
