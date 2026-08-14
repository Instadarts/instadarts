// The motion gate: only run inference when the board actually changed.
//
// This is the top-level performance decision in the whole pipeline — it is what keeps a phone cool
// for four hours. Two analyzers implement the same idea, a WebGPU one and a CPU one, and the gate
// classifies what changed: dart-sized motion triggers an inference, a large motion (an arm, someone
// walking past) waits for the picture to settle first.
//
// The thresholds, the tile grid and the quiet-frame debounce are measurements against real boards
// and real phones. Do not retune them without one in front of you.
//
// It owns no DOM. It reads the preview video for pixels and *reports* what it decided — armed or
// not, how fast it is sampling, which tiles moved — and the host renders that however it likes.
// Nothing here writes to a button or a badge, so React and this module never disagree about who
// owns a node.

import { getWebGpuDevice } from "@litertjs/core";
import { diffMask, fillTileCounts, gaussianBlur, rgbaToGray, type MotionDefaults } from './motionAnalysis';

export type { MotionDefaults };



/** What the gate is doing, for whoever is drawing it. */
export interface MotionReport {
  armed: boolean;
  /** Whether arming and manual triggering are currently possible at all. */
  canArm: boolean;
  canTrigger: boolean;
  /** What the badge's dot shows: nothing happening, waiting for the picture to settle, or firing. */
  dot: 'idle' | 'pending' | 'pendingLarge' | 'triggered';
  /** How many analyzer passes a second, or null while nothing is being sampled. */
  fps: number | null;
  /** Which analyzer ran: cpu or webgpu. */
  mode: string;
}

/** Grid dimensions — the host pre-renders one cell per tile and toggles them via CSS. */
export const MOTION_GRID_ROWS = 8;
export const MOTION_GRID_COLS = 8;

export interface MotionDetectorOptions {
  preview: HTMLVideoElement;
  /** Whether arming is allowed at all — false while there is no camera. */
  canArm: () => boolean;
  canTrigger: () => boolean;
  /** An inference is already running; a trigger now would queue behind it. */
  isTriggerBusy: () => boolean;
  getTileChangePercent?: () => number;
  onArmedChange?: (armed: boolean) => void;
  onTrigger: () => void;
  /** Called whenever anything a renderer would show has changed. */
  onReport?: (report: MotionReport) => void;
  /** Tile indices (0..63) that changed in this pass, for the preview overlay. */
  onTiles?: (tileIndices: number[]) => void;
}

/** What the pipeline above drives the gate with. */
export interface MotionDetector {
  arm: () => void;
  disarm: () => void;
  isArmed: () => boolean;
  /** Disarms as well; this is how a caller puts the state back as it found it. */
  reset: () => void;
  /** Remember that a trigger was wanted while an inference was already running. */
  queueTriggerIfArmed: () => void;
  flushQueuedTrigger: () => void;
  /** Select the CPU analyzer without changing whether automatic scanning is armed. */
  setForceCpu: (force: boolean) => void;
  /**
   * One analyzer pass, run now and timed. For measurement only — see the onboarding self-test.
   *
   * Exists because nothing else here can answer "how long does a pass take". The loop is paced to
   * one pass per 100 ms, so `MotionReport.fps` measures the pacing rather than the work and tops
   * out around ten however fast the device is.
   *
   * Goes through the same analyzer selection as the loop, so whichever path a real frame would take
   * is the path timed — including a WebGPU analyzer that has already fallen back. It does **not**
   * touch armed state, the debounce, the fps window or the badge: a measurement that changed what it
   * measured would be worth nothing.
   *
   * `mode` is what actually ran, never what was asked for.
   */
  analyzeOnce: () => Promise<{ ms: number; mode: string }>;
}

/**
 * One pass over the picture: how many pixels changed in each tile of the grid.
 *
 * Two implementations, a compute shader and a canvas loop, and the gate above cannot tell them
 * apart — which is what lets it fall back to the CPU mid-run when the GPU one throws.
 */
interface MotionAnalyzer {
  analyze: (preview: HTMLVideoElement) => Promise<AnalyzeResult>;
  reset?: () => void;
  /** Latched by the WebGPU analyzer when its device goes away. */
  disabled?: boolean;
}

interface AnalyzeResult {
  mode: string;
  /** False on the very first frame: with nothing to diff against, nothing has changed. */
  hasPrevious: boolean;
  tileCounts: Uint32Array;
}

const ENABLE_WEBGPU_MOTION_DETECTOR = true;
const MOTION_ANALYZE_FPS_WINDOW = 2000;
const DETECTOR_BADGE_UPDATE_MS = 500;
const WEBGPU_MOTION_WORKGROUP_SIZE = 16;

const MOTION_DEFAULTS: MotionDefaults = {
  gridRows: 8,
  gridCols: 8,
  tileChangePercent: 3,
  minTiles: 1,
  maxTiles: 8,
  pixelThreshold: 25,
  pixelThresholdMult: 0.2,
  analyzeSize: 240,
  quietTimeMs: 300,
  quietFrames: 3,
  // Large motion (e.g. an arm reaching in to clear the board) arms a trigger too,
  // but must stay quiet this many times longer before firing than a dart-sized
  // motion — it's lower confidence, so we wait for the scene to fully settle.
  largeMotionQuietMultiplier: 2,
};

const WEBGPU_MOTION_HBLUR_SHADER = `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<storage, read_write> currentGray: array<u32>;
@group(0) @binding(3) var<storage, read_write> hBlur: array<u32>;

struct Params {
  analyzeSize: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(4) var<uniform> params: Params;

fn sampleDownscaledRgb(uv: vec2<f32>) -> vec3<f32> {
  let sourceDimensions = textureDimensions(sourceTexture);
  if (sourceDimensions.x <= params.analyzeSize && sourceDimensions.y <= params.analyzeSize) {
    return textureSampleLevel(sourceTexture, sourceSampler, uv, 0.0).rgb;
  }

  let sourceSize = vec2<f32>(f32(sourceDimensions.x), f32(sourceDimensions.y));
  let minUv = vec2<f32>(0.5, 0.5) / sourceSize;
  let maxUv = vec2<f32>(1.0, 1.0) - minUv;
  var rgbSum = vec3<f32>(0.0, 0.0, 0.0);

  for (var sampleY = 0u; sampleY < 4u; sampleY = sampleY + 1u) {
    for (var sampleX = 0u; sampleX < 4u; sampleX = sampleX + 1u) {
      let sampleOffset = ((vec2<f32>(f32(sampleX), f32(sampleY)) + vec2<f32>(0.5, 0.5)) / 4.0) - vec2<f32>(0.5, 0.5);
      let sampleUv = clamp(uv + (sampleOffset / f32(params.analyzeSize)), minUv, maxUv);
      rgbSum = rgbSum + textureSampleLevel(sourceTexture, sourceSampler, sampleUv, 0.0).rgb;
    }
  }

  return rgbSum / 16.0;
}

fn sampleGrayAt(x: i32, y: i32) -> u32 {
  let uvf = vec2<f32>(f32(x), f32(y)) + vec2<f32>(0.5, 0.5);
  let uv = uvf / f32(params.analyzeSize);
  let rgb = sampleDownscaledRgb(uv);
  let grayF = dot(rgb, vec3<f32>(0.299, 0.587, 0.114)) * 255.0;
  return u32(round(clamp(grayF, 0.0, 255.0)));
}

@compute @workgroup_size(${WEBGPU_MOTION_WORKGROUP_SIZE}, ${WEBGPU_MOTION_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.analyzeSize || id.y >= params.analyzeSize) {
    return;
  }

  let x = i32(id.x);
  let y = i32(id.y);
  let size = i32(params.analyzeSize);
  let index = id.y * params.analyzeSize + id.x;

  // Horizontal 5-tap Gaussian [1, 4, 6, 4, 1] — each neighbour re-samples the source
  // independently so there is no cross-thread data dependency inside the dispatch.
  var hSum = u32(0);
  let weights = array<i32, 5>(1, 4, 6, 4, 1);
  for (var i = 0u; i < 5u; i = i + 1u) {
    let ox = i32(i) - 2i;
    let sx = clamp(x + ox, 0i, size - 1i);
    let g = sampleGrayAt(sx, y);
    hSum = hSum + g * u32(weights[i]);
  }
  hBlur[index] = hSum;

  // Also store the raw (un-blurred) centre-pixel grayscale — unused by the motion
  // pipeline but kept so the CPU/GPU paths write identical state for tests.
  currentGray[index] = sampleGrayAt(x, y);
}
`;

const WEBGPU_MOTION_VBLUR_DIFF_AGGREGATE_SHADER = `
@group(0) @binding(0) var<storage, read> hBlur: array<u32>;
@group(0) @binding(1) var<storage, read_write> currentBlurred: array<u32>;
@group(0) @binding(2) var<storage, read> previousBlurred: array<u32>;
@group(0) @binding(3) var<storage, read_write> tileCounts: array<atomic<u32>>;

struct Params {
  analyzeSize: u32,
  pixelThreshold: u32,
  hasPrevious: u32,
  pixelThresholdMultBits: u32,
  gridRows: u32,
  gridCols: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(${WEBGPU_MOTION_WORKGROUP_SIZE}, ${WEBGPU_MOTION_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.analyzeSize || id.y >= params.analyzeSize) {
    return;
  }

  let x = i32(id.x);
  let y = i32(id.y);
  let size = i32(params.analyzeSize);
  let index = id.y * params.analyzeSize + id.x;

  // Vertical 5-tap Gaussian [1, 4, 6, 4, 1] from the hBlur intermediate.
  var vSum = u32(0);
  let weights = array<i32, 5>(1, 4, 6, 4, 1);
  for (var i = 0u; i < 5u; i = i + 1u) {
    let oy = i32(i) - 2i;
    let sy = clamp(y + oy, 0i, size - 1i);
    vSum = vSum + hBlur[u32(sy) * params.analyzeSize + id.x] * u32(weights[i]);
  }

  // Two-pass normalisation: each pass sums to 16, combined ÷256.
  let blurred = vSum / 256u;
  currentBlurred[index] = blurred;

  if (params.hasPrevious == 0u) {
    return;
  }

  let prev = previousBlurred[index];
  let diff = select(prev - blurred, blurred - prev, blurred >= prev);

  // Dynamic threshold: parabolic ramp from pixelThresholdMult at brightness
  // extremes (0 / 255) up to 1.0 at mid-grey (128).
  // Uses *previous* blurred pixel — the board background (black/white extremes)
  // gets a lower threshold so a mid-grey dart tip landing on it is detected more easily.
  let pixelThresholdMult = bitcast<f32>(params.pixelThresholdMultBits);
  let t = (f32(prev) - 128.0) / 128.0;
  let factor = 1.0 - (1.0 - pixelThresholdMult) * t * t;
  let effectiveThreshold = f32(params.pixelThreshold) * factor;
  if (f32(diff) < effectiveThreshold) {
    return;
  }

  let tileHeight = params.analyzeSize / params.gridRows;
  let tileWidth = params.analyzeSize / params.gridCols;
  let tileRow = min(id.y / tileHeight, params.gridRows - 1u);
  let tileCol = min(id.x / tileWidth, params.gridCols - 1u);
  atomicAdd(&tileCounts[tileRow * params.gridCols + tileCol], 1u);
}
`;

/**
 * The nodes are passed in rather than looked up, so the host owns its own DOM and two detectors can
 * never fight over one set of ids.
 */
export function createMotionDetector({
  preview,
  canArm,
  canTrigger,
  isTriggerBusy,
  getTileChangePercent = () => MOTION_DEFAULTS.tileChangePercent,
  onArmedChange = () => {},
  onTrigger,
  onReport = () => {},
  onTiles = () => {},
}: MotionDetectorOptions): MotionDetector {

  let motionArmed = false;
  let motionBusy = false;
  let motionLoopToken = 0;
  let motionLastTriggerAt = 0;
  let motionPendingTrigger = false;
  // Quiet-time/frames multiplier for the current pending trigger: 1 for a
  // dart-sized motion, largeMotionQuietMultiplier for a large-motion one.
  let pendingQuietScale = 1;
  let motionQuietFrames = 0;
  let triggerQueued = false;
  let analyzeTimestamps: number[] = [];
  let detectorDotState: MotionReport['dot'] = 'idle';
  let detectorMode = "cpu";
  let lastDetectorBadgeUpdatedAt = 0;
  let detectorBadgeUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let cpuAnalyzer: MotionAnalyzer | null = null;
  let gpuAnalyzer: MotionAnalyzer | null = null;
  // Latches once the WebGPU analyzer fails to construct (e.g. no WebGPU device),
  // so getActiveAnalyzer doesn't retry — and re-log — every frame.
  let gpuAnalyzerUnavailable = false;
  let forceCpu = false;

  function updateControls() {
    report();
  }

  /** Everything a renderer needs, in one call. Cheap: it is a small object, not a repaint. */
  function report() {
    onReport({
      armed: motionArmed,
      canArm: canArm(),
      canTrigger: canTrigger() && !motionArmed,
      dot: detectorDotState,
      fps: analyzeTimestamps.length
        ? Number((analyzeTimestamps.length / (MOTION_ANALYZE_FPS_WINDOW / 1000)).toFixed(1))
        : null,
      mode: detectorMode,
    });
  }

  function arm() {
    if (!canArm()) return;
    motionArmed = true;
    motionQuietFrames = 0;
    motionPendingTrigger = false;
    pendingQuietScale = 1;
    triggerQueued = false;
    clearMotionHighlights();
    cpuAnalyzer?.reset?.();
    gpuAnalyzer?.reset?.();
    motionLoopToken += 1;
    updateControls();
    onArmedChange(true);
    updateDetectorDot("idle");
    runMotionLoop(motionLoopToken);
  }

  function disarm() {
    motionArmed = false;
    motionLoopToken += 1;
    updateControls();
    onArmedChange(false);
  }

  function reset() {
    disarm();
    motionPendingTrigger = false;
    pendingQuietScale = 1;
    motionQuietFrames = 0;
    triggerQueued = false;
    analyzeTimestamps = [];
    detectorDotState = "idle";
    clearDetectorBadgeUpdateTimer();
    clearMotionHighlights();
    report();
    cpuAnalyzer?.reset?.();
    gpuAnalyzer?.reset?.();
  }

  function isArmed() {
    return motionArmed;
  }

  function queueTriggerIfArmed() {
    if (motionArmed) {
      triggerQueued = true;
    }
  }

  function flushQueuedTrigger() {
    if (triggerQueued && !isTriggerBusy() && !motionPendingTrigger) {
      triggerQueued = false;
      onTrigger();
    }
  }

  async function runMotionLoop(token: number) {
    if (token !== motionLoopToken || !motionArmed) return;

    const t0 = performance.now();
    if (!motionBusy) {
      motionBusy = true;
      try {
        recordAnalyzeRun();
        await processMotionFrame();
        checkMotionDebounce();
        flushQueuedTrigger();
      } catch (e) {
        console.error("[ADPA] Motion error:", e);
      } finally {
        motionBusy = false;
      }
    }
    const delay = Math.max(0, t0 + 100 - performance.now());
    setTimeout(() => runMotionLoop(token), delay);
  }

  async function processMotionFrame() {
    if (!preview.videoWidth || !preview.videoHeight) return;

    const analyzer = getActiveAnalyzer();
    let result: AnalyzeResult;
    try {
      result = await analyzer.analyze(preview);
    } catch (e) {
      if (analyzer !== gpuAnalyzer) {
        throw e;
      }
      if (!cpuAnalyzer) {
        cpuAnalyzer = createCpuMotionAnalyzer(MOTION_DEFAULTS);
      }
      result = await cpuAnalyzer.analyze(preview);
    }
    detectorMode = result.mode;
    if (!result.hasPrevious) {
      requestDetectorBadgeUpdate();
      return;
    }

    const motionResult = classifyTileCounts(result.tileCounts);
    const detected = motionResult.detected;
    if (detected >= 1) {
      showMotionHighlights(motionResult.triggeredTiles);
      // Any motion (re)starts the quiet window and arms a pending trigger. The
      // settle requirement scales up the moment large motion is involved — whether
      // as the initial event or later during the debounce — and never scales back
      // down. Darts never produce large motion (that's how the 1–8 tile range is
      // tuned), so any large-motion frame means a hand/arm is in frame and the
      // scene needs longer to settle. (An arm reaching in is often first seen as a
      // partial, dart-sized motion and only registers as large a frame or two on.)
      const wasPending = motionPendingTrigger;
      motionLastTriggerAt = performance.now();
      motionQuietFrames = 0;
      motionPendingTrigger = true;
      if (detected === 2) {
        pendingQuietScale = MOTION_DEFAULTS.largeMotionQuietMultiplier;
      } else if (!wasPending) {
        pendingQuietScale = 1;
      }
      triggerQueued = false;
      updateDetectorDot(detected === 2 ? "pendingLarge" : "pending");
    }
    if (detected === 0) {
      motionQuietFrames += 1;
      if (!motionPendingTrigger) updateDetectorDot("idle");
    }
  }

  /**
   * See `MotionDetector.analyzeOnce`.
   *
   * No fallback to the CPU analyzer when the GPU one throws, unlike `processMotionFrame` above: a
   * caller measuring the GPU path wants to be told it failed, not handed a CPU number under a GPU
   * heading. It measures the other path in its own call.
   */
  async function analyzeOnce(): Promise<{ ms: number; mode: string }> {
    if (!preview.videoWidth || !preview.videoHeight) {
      throw new Error('motion: nothing to analyze — the preview has no frame yet');
    }
    const started = performance.now();
    const result = await getActiveAnalyzer().analyze(preview);
    return { ms: performance.now() - started, mode: result.mode };
  }

  function getActiveAnalyzer() {
    if (!forceCpu && ENABLE_WEBGPU_MOTION_DETECTOR && !gpuAnalyzerUnavailable) {
      if (!gpuAnalyzer) {
        try {
          gpuAnalyzer = createWebGpuMotionAnalyzer({
            defaults: MOTION_DEFAULTS,
            onModeChange: (mode) => {
              detectorMode = mode;
              requestDetectorBadgeUpdate();
            },
          });
        } catch (e) {
          gpuAnalyzerUnavailable = true;
          console.warn("[ADPA] WebGPU motion detector unavailable; using CPU detector", e);
        }
      }
      if (gpuAnalyzer && !gpuAnalyzer.disabled) {
        return gpuAnalyzer;
      }
    }
    if (!cpuAnalyzer) {
      cpuAnalyzer = createCpuMotionAnalyzer(MOTION_DEFAULTS);
    }
    return cpuAnalyzer;
  }

  function classifyTileCounts(tileCounts: Uint32Array) {
    const tileThreshold = getTileChangePercent() / 100;
    const tilePixelCount = (MOTION_DEFAULTS.analyzeSize / MOTION_DEFAULTS.gridRows)
      * (MOTION_DEFAULTS.analyzeSize / MOTION_DEFAULTS.gridCols);
    let activeTiles = 0;
    let maxTileRatio = 0;
    const triggeredTiles = [];

    for (let i = 0; i < tileCounts.length; i += 1) {
      const ratio = tileCounts[i] / tilePixelCount;
      maxTileRatio = Math.max(maxTileRatio, ratio);
      if (ratio >= tileThreshold) {
        activeTiles += 1;
        triggeredTiles.push(i);
      }
    }

    if (maxTileRatio < tileThreshold || activeTiles < MOTION_DEFAULTS.minTiles) {
      return { detected: 0, triggeredTiles: [] };
    }
    if (activeTiles > MOTION_DEFAULTS.maxTiles) {
      return { detected: 2, triggeredTiles };
    }
    return { detected: 1, triggeredTiles };
  }

  function showMotionHighlights(tileIndexes: number[]) {
    onTiles(tileIndexes);
  }

  function clearMotionHighlights() {
    onTiles([]);
  }

  function checkMotionDebounce() {
    if (!motionPendingTrigger) return;
    const now = performance.now();
    const quietElapsed = now - motionLastTriggerAt;
    const requiredQuietTime = MOTION_DEFAULTS.quietTimeMs * pendingQuietScale;
    const requiredQuietFrames = MOTION_DEFAULTS.quietFrames * pendingQuietScale;
    if (quietElapsed >= requiredQuietTime && motionQuietFrames >= requiredQuietFrames) {
      motionPendingTrigger = false;
      pendingQuietScale = 1;
      motionQuietFrames = 0;
      updateDetectorDot("triggered");
      // The next frame with no motion will set idle; CSS handles the visual fade.
      onTrigger();
    }
  }

  function updateDetectorDot(state: MotionReport['dot']) {
    const changed = detectorDotState !== state;
    detectorDotState = state;
    if (changed) {
      // Dot changes are events, not rates — bypass the fps throttle so they
      // always reach the screen, even when one fires inside a throttle window.
      clearDetectorBadgeUpdateTimer();
      renderDetectorBadge();
    }
  }

  function recordAnalyzeRun() {
    const now = performance.now();
    analyzeTimestamps.push(now);
    trimAnalyzeTimestamps(now);
    requestDetectorBadgeUpdate();
  }

  function trimAnalyzeTimestamps(now: number) {
    const cutoff = now - MOTION_ANALYZE_FPS_WINDOW;
    while (analyzeTimestamps.length && analyzeTimestamps[0] < cutoff) {
      analyzeTimestamps.shift();
    }
  }

  function requestDetectorBadgeUpdate() {
    const now = performance.now();
    const waitMs = DETECTOR_BADGE_UPDATE_MS - (now - lastDetectorBadgeUpdatedAt);
    if (waitMs <= 0) {
      clearDetectorBadgeUpdateTimer();
      renderDetectorBadge();
      return;
    }
    if (detectorBadgeUpdateTimer) return;
    detectorBadgeUpdateTimer = setTimeout(() => {
      detectorBadgeUpdateTimer = null;
      renderDetectorBadge();
    }, waitMs);
  }

  function clearDetectorBadgeUpdateTimer() {
    if (!detectorBadgeUpdateTimer) return;
    clearTimeout(detectorBadgeUpdateTimer);
    detectorBadgeUpdateTimer = null;
  }

  function renderDetectorBadge() {
    lastDetectorBadgeUpdatedAt = performance.now();
    report();
  }

  setInterval(() => {
    if (!analyzeTimestamps.length) return;
    trimAnalyzeTimestamps(performance.now());
    requestDetectorBadgeUpdate();
  }, 1000);

  updateControls();

  function setForceCpu(next: boolean) {
    const force = Boolean(next);
    if (force === forceCpu) return;
    forceCpu = force;
    // The two implementations keep their own previous frame. Neither may compare a new frame with
    // history captured before the path changed, or toggling this diagnostic could look like motion.
    cpuAnalyzer?.reset?.();
    gpuAnalyzer?.reset?.();
    motionPendingTrigger = false;
    pendingQuietScale = 1;
    motionQuietFrames = 0;
    triggerQueued = false;
    analyzeTimestamps = [];
    detectorMode = forceCpu ? 'cpu' : 'webgpu';
    clearMotionHighlights();
    report();
  }

  return {
    arm,
    disarm,
    reset,
    isArmed,
    queueTriggerIfArmed,
    flushQueuedTrigger,
    setForceCpu,
    analyzeOnce,
  };
}

function createCpuMotionAnalyzer(defaults: MotionDefaults): MotionAnalyzer {
  let motionCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  let motionCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  let previousGray: Uint8Array | null = null;  // blurred grayscale from the previous frame
  const tileCounts = new Uint32Array(defaults.gridRows * defaults.gridCols);

  function ensureCanvas() {
    if (motionCanvas && motionCtx) return;
    if (typeof OffscreenCanvas === "function") {
      motionCanvas = new OffscreenCanvas(defaults.analyzeSize, defaults.analyzeSize);
    } else {
      motionCanvas = document.createElement("canvas");
      motionCanvas.width = defaults.analyzeSize;
      motionCanvas.height = defaults.analyzeSize;
    }
    motionCtx = motionCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    motionCtx!.imageSmoothingEnabled = true;
    motionCtx!.imageSmoothingQuality = "high";
  }

  /** The canvas and its context, built on first use. */
  function context() {
    ensureCanvas();
    return motionCtx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  }

  return {
    disabled: false,
    reset() {
      previousGray = null;
    },
    async analyze(sourceFrame) {
      const ctx = context();
      const { cropX, cropY, cropSize } = getCenterSquareCrop(sourceFrame);
      ctx.drawImage(
        sourceFrame,
        cropX, cropY, cropSize, cropSize,
        0, 0, defaults.analyzeSize, defaults.analyzeSize
      );

      const imageData = ctx.getImageData(0, 0, defaults.analyzeSize, defaults.analyzeSize);
      const rawGray = rgbaToGray(imageData.data);
      // Gaussian blur before differencing — the Android-proven strategy.
      const currentGray = gaussianBlur(rawGray, defaults.analyzeSize);
      const hasPrevious = Boolean(previousGray);
      tileCounts.fill(0);

      if (hasPrevious) {
        const mask = diffMask(previousGray as Uint8Array, currentGray, defaults);
        fillTileCounts(mask, tileCounts, defaults);
      }
      previousGray = currentGray;
      return {
        mode: "cpu",
        hasPrevious,
        tileCounts,
      };
    },
  };
}






function createWebGpuMotionAnalyzer({ defaults, onModeChange }: { defaults: MotionDefaults; onModeChange: (mode: string) => void }): MotionAnalyzer {
  const maybeDevice = getWebGpuDevice();
  if (!maybeDevice) {
    throw new Error("LiteRT WebGPU device is not available");
  }
  // Bound again so it is non-null for the closures below: a narrowing does not survive into them.
  const device: GPUDevice = maybeDevice;

  const hBlurPipeline = device.createComputePipeline({
    label: "ADPA motion h-blur pipeline",
    layout: "auto",
    compute: {
      module: device.createShaderModule({
        label: "ADPA motion h-blur shader",
        code: WEBGPU_MOTION_HBLUR_SHADER,
      }),
      entryPoint: "main",
    },
  });
  const vBlurDiffAggregatePipeline = device.createComputePipeline({
    label: "ADPA motion v-blur diff aggregate pipeline",
    layout: "auto",
    compute: {
      module: device.createShaderModule({
        label: "ADPA motion v-blur diff aggregate shader",
        code: WEBGPU_MOTION_VBLUR_DIFF_AGGREGATE_SHADER,
      }),
      entryPoint: "main",
    },
  });
  const sampler = device.createSampler({
    label: "ADPA motion sampler",
    magFilter: "linear",
    minFilter: "linear",
  });

  const size = defaults.analyzeSize;
  const pixelCount = size * size;
  const tileCount = defaults.gridRows * defaults.gridCols;
  const grayBufferSize = pixelCount * Uint32Array.BYTES_PER_ELEMENT;
  const tileCountsBufferSize = tileCount * Uint32Array.BYTES_PER_ELEMENT;
  const tileCounts = new Uint32Array(tileCount);
  const zeroTileCounts = new Uint32Array(tileCount);
  let sourceTexture: GPUTexture | null = null;
  let sourceSize = 0;
  let disabled = false;
  let hasPrevious = false;
  const mode = "gpu-bitmap";
  let hBlurBindGroup: GPUBindGroup | null = null;
  let vBlurDiffAggregateBindGroup: GPUBindGroup | null = null;

  const currentGrayBuffer = createStorageBuffer("ADPA motion current gray", grayBufferSize);
  const hBlurBuffer = createStorageBuffer("ADPA motion h-blur", grayBufferSize);
  const previousBlurredBuffer = createStorageBuffer("ADPA motion previous blurred", grayBufferSize);
  const currentBlurredBuffer = createStorageBuffer("ADPA motion current blurred", grayBufferSize);
  const tileCountsBuffer = device.createBuffer({
    label: "ADPA motion tile counts",
    size: tileCountsBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const readbackBuffer = device.createBuffer({
    label: "ADPA motion tile counts readback",
    size: tileCountsBufferSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const hBlurParamsBuffer = device.createBuffer({
    label: "ADPA motion h-blur params",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const vBlurParamsBuffer = device.createBuffer({
    label: "ADPA motion v-blur params",
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  console.info("[ADPA] WebGPU motion detector enabled");

  function createStorageBuffer(label: string, bufferSize: number): GPUBuffer {
    return device.createBuffer({
      label,
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  }

  function ensureSourceTexture(textureSize: number): void {
    if (sourceTexture && sourceSize === textureSize) return;
    sourceTexture?.destroy?.();
    sourceTexture = device.createTexture({
      label: "ADPA motion source texture",
      size: [textureSize, textureSize, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    sourceSize = textureSize;
    hBlurBindGroup = null;
  }

  function ensureHBlurBindGroup() {
    if (hBlurBindGroup) return hBlurBindGroup;
    hBlurBindGroup = device.createBindGroup({
      label: "ADPA motion h-blur bind group",
      layout: hBlurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sourceTexture!.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: currentGrayBuffer } },
        { binding: 3, resource: { buffer: hBlurBuffer } },
        { binding: 4, resource: { buffer: hBlurParamsBuffer } },
      ],
    });
    return hBlurBindGroup;
  }

  function ensureVBlurDiffAggregateBindGroup() {
    if (vBlurDiffAggregateBindGroup) return vBlurDiffAggregateBindGroup;
    vBlurDiffAggregateBindGroup = device.createBindGroup({
      label: "ADPA motion v-blur diff aggregate bind group",
      layout: vBlurDiffAggregatePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: hBlurBuffer } },
        { binding: 1, resource: { buffer: currentBlurredBuffer } },
        { binding: 2, resource: { buffer: previousBlurredBuffer } },
        { binding: 3, resource: { buffer: tileCountsBuffer } },
        { binding: 4, resource: { buffer: vBlurParamsBuffer } },
      ],
    });
    return vBlurDiffAggregateBindGroup;
  }

  async function copyImageBitmapToTexture(sourceFrame: HTMLVideoElement) {
    if (typeof createImageBitmap !== "function") {
      throw new Error("createImageBitmap is not available");
    }
    const { cropX, cropY, cropSize } = getCenterSquareCrop(sourceFrame);
    const bitmap = await createImageBitmap(sourceFrame, cropX, cropY, cropSize, cropSize, {
      resizeWidth: size,
      resizeHeight: size,
      resizeQuality: "high",
    });
    // Size the texture from the *returned* bitmap, not the requested `size`: if a browser ignores
    // the resize options and hands back a crop-sized bitmap, the h-blur shader's downsample
    // branch (via sampleDownscaledRgb) still scales it correctly, and we avoid an out-of-bounds copy.
    try {
      ensureSourceTexture(bitmap.width);
      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: sourceTexture! },
        { width: bitmap.width, height: bitmap.height }
      );
    } finally {
      bitmap.close?.();
    }
  }

  async function analyze(sourceFrame: HTMLVideoElement): Promise<AnalyzeResult> {
    // WebGPU reports copy/dispatch failures asynchronously rather than throwing, so wrap the GPU
    // region in error scopes (balanced in `finally`) to detect them and fall back to the CPU
    // detector instead of silently analyzing a garbage frame.
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    let scopePopped = false;
    try {
      await copyImageBitmapToTexture(sourceFrame);
      onModeChange(mode);
      device.queue.writeBuffer(hBlurParamsBuffer, 0, new Uint32Array([
        size,
        0, 0, 0,
      ]));
      device.queue.writeBuffer(vBlurParamsBuffer, 0, new Uint32Array([
        size,
        defaults.pixelThreshold,
        hasPrevious ? 1 : 0,
        new Uint32Array(new Float32Array([defaults.pixelThresholdMult]).buffer)[0],
        defaults.gridRows,
        defaults.gridCols,
        0, 0,
      ]));
      device.queue.writeBuffer(tileCountsBuffer, 0, zeroTileCounts);

      const encoder = device.createCommandEncoder({
        label: "ADPA motion command encoder",
      });
      const pass = encoder.beginComputePass({
        label: "ADPA motion compute pass",
      });
      const workgroupCount = Math.ceil(size / WEBGPU_MOTION_WORKGROUP_SIZE);
      pass.setPipeline(hBlurPipeline);
      pass.setBindGroup(0, ensureHBlurBindGroup());
      pass.dispatchWorkgroups(workgroupCount, workgroupCount);
      pass.setPipeline(vBlurDiffAggregatePipeline);
      pass.setBindGroup(0, ensureVBlurDiffAggregateBindGroup());
      pass.dispatchWorkgroups(workgroupCount, workgroupCount);
      pass.end();
      encoder.copyBufferToBuffer(tileCountsBuffer, 0, readbackBuffer, 0, tileCountsBufferSize);
      // Copy the newly blurred frame into previous, ready for the next pass.
      encoder.copyBufferToBuffer(currentBlurredBuffer, 0, previousBlurredBuffer, 0, grayBufferSize);
      device.queue.submit([encoder.finish()]);

      const validationError = await device.popErrorScope();
      const oomError = await device.popErrorScope();
      scopePopped = true;
      const scopeError = validationError || oomError;
      if (scopeError) {
        throw new Error(`WebGPU motion error: ${scopeError.message || scopeError}`);
      }

      await readbackBuffer.mapAsync(GPUMapMode.READ);
      try {
        tileCounts.set(new Uint32Array(readbackBuffer.getMappedRange()));
      } finally {
        readbackBuffer.unmap();
      }

      const resultHasPrevious = hasPrevious;
      hasPrevious = true;
      return {
        mode,
        hasPrevious: resultHasPrevious,
        tileCounts,
      };
    } catch (e) {
      disabled = true;
      console.warn("[ADPA] WebGPU motion detector failed; using CPU detector", e);
      throw e;
    } finally {
      if (!scopePopped) {
        // Balance the error scopes if we threw before popping them above.
        await device.popErrorScope().catch(() => {});
        await device.popErrorScope().catch(() => {});
      }
    }
  }

  function reset() {
    hasPrevious = false;
  }

  return {
    get disabled() {
      return disabled;
    },
    reset,
    analyze,
  };
}

function getSourceDimensions(source: HTMLVideoElement): { width: number; height: number } {
  // A video names its size three different ways depending on where it came from.
  const any = source as { videoWidth?: number; displayWidth?: number; width?: number; videoHeight?: number; displayHeight?: number; height?: number };
  const width = any.videoWidth || any.displayWidth || any.width || 0;
  const height = any.videoHeight || any.displayHeight || any.height || 0;
  if (!width || !height) throw new Error("Invalid source dimensions");
  return { width, height };
}

function getCenterSquareCrop(source: HTMLVideoElement): { cropX: number; cropY: number; cropSize: number } {
  const { width, height } = getSourceDimensions(source);
  const cropSize = Math.min(width, height);
  return {
    cropX: Math.max(0, Math.floor((width - cropSize) / 2)),
    cropY: Math.max(0, Math.floor((height - cropSize) / 2)),
    cropSize,
  };
}
