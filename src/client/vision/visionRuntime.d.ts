// Types for visionRuntime.js. The vision modules stay plain JS so they keep diffing cleanly
// against the originals they were ported from, so the TypeScript side gets its contract here
// instead of through inference — which would otherwise read the default `() => {}` callbacks as
// taking no arguments.

import type { BoardTip, Keypoint } from '../../shared/vision/types';
import type { PipelineResult } from './predictionPipeline';

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

export type CameraInfo = { deviceId: string; label: string };

/** What the camera module exposes; see src/vision/camera.js. */
export type CameraControl = {
  readonly active: boolean;
  readonly label: string;
  readonly settings: MediaTrackSettings;
  zoomRange: () => { min: number; max: number; step: number } | null;
  applyZoom: (value: number) => Promise<number | null>;
  storedZoom: () => number | null;
};

/** The copied motion detector, as far as the app drives it (src/vision/motion.js). */
export type MotionControl = {
  arm: () => void;
  disarm: () => void;
  /** reset() disarms as well; this is how callers put the state back as they found it. */
  isArmed: () => boolean;
  reset: () => void;
};

export type VisionRuntime = {
  listCameras: () => Promise<CameraInfo[]>;
  camera: CameraControl;
  motion: MotionControl;
  preferredCamera: (cameras: CameraInfo[]) => CameraInfo | null;
  infer: () => Promise<BoardTip[]>;
  start: (deviceId: string) => Promise<{ label: string; settings: MediaTrackSettings }>;
  stop: () => Promise<void>;
  unload: () => Promise<void>;
  setModel: (key: string) => void;
  setLensCalibration: (value: number) => void;
  /** Slider position, for the retained `config` message the camera publishes (§5.2). */
  readonly lensCalibration: number;
  setThresholds: (thresholds: { board?: number; tip?: number }) => void;
  readonly modelKey: string;
  /** Side of the square the model is fed — the coordinate space keypoints are normalised in. */
  readonly inputSize: number;
  /** Keep a copy of each inference's input square, for the frozen calibration frame. */
  setKeepInputFrame: (on: boolean) => void;
  /** Paint that copy into a 2D context; false when no frame has been kept yet. */
  drawInputFrame: (targetCtx: CanvasRenderingContext2D, size: number) => boolean;
};

export const MODELS: Record<string, { url: string; inputSize: number }>;

/** The five nodes the motion detector binds; see src/client/vision/motion.js. */
export type MotionElements = {
  arm: HTMLElement | null;
  disarm: HTMLElement | null;
  trigger: HTMLElement | null;
  metrics: HTMLElement | null;
  highlights: HTMLElement | null;
};

export function createVisionRuntime(options: {
  video: HTMLVideoElement;
  elements: MotionElements;
  /**
   * Fires on every inference that produced a homography, including ones that found no tips at
   * all — an empty array is the takeout signal (v2 §5.4). A frame with no homography fires
   * nothing, because "the board is not visible" is not "the board is empty".
   */
  onTips: (tips: BoardTip[]) => void;
  onStatus?: (status: VisionStatus) => void;
  onFrame?: (frame: FrameInfo) => void;
}): VisionRuntime;
