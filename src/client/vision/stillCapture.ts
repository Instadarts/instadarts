// Photographing a square of the board.
//
// A still request names a region in **board space** — "this quarter of the board, centred on where
// that dart landed" — and says nothing about cameras, because the asker knows nothing about this
// one. Turning that into pixels is this file's whole job, and it is the only place in the app where
// the geometry runs backwards.
//
// ```
// board point ──(inverse homography)──▶ undistorted normalized
//              ──(distortNormalizedPoint)──▶ normalized frame
//              ──(the model's centre-square crop)──▶ video pixels
// ```
//
// Every step but the inverse already existed, because the forward trip — a keypoint becoming a board
// coordinate — is what the pipeline does on every inference. This just walks it the other way, with
// the same lens value the homography was solved under.

import type { Matrix3x3, Point2D } from '../../shared/vision/types';
import type { Region } from '../../shared/media';
import { BOARD_MAX } from '../../shared/scoring';
import { invertMatrix3x3, transformPoint } from '../../shared/vision/homography';
import { distortNormalizedPoint, sliderValueToLensK1 } from '../../shared/vision/lensDistortion';
import { getCenterSquareCrop } from './model';

/** A square of the source frame, in its own pixels. */
export interface CropRect {
  x: number;
  y: number;
  size: number;
}

export interface CropInput {
  region: Region;
  /** The image→board homography this camera last solved. */
  homography: Matrix3x3;
  /** The lens slider value the homography was solved under. */
  lensCalibration: number;
  /** Where the model's input square sits in the video frame. */
  crop: { cropX: number; cropY: number; cropSize: number };
  /** The video's own dimensions, for clamping. */
  frame: { width: number; height: number };
}

/**
 * Where a board-space region lands in the camera's frame.
 *
 * **The bounding square, not a warp.** The region's four corners map to a quadrilateral — a board
 * seen at an angle is not a rectangle — and the square that contains it is what gets cut out. The
 * dart then looks the way the camera saw it, angle and all, which is what makes it evidence rather
 * than a diagram. Rectifying it straight-on is a different picture and a different feature.
 *
 * Null when the region cannot be placed: a homography that will not invert, or corners that project
 * behind the camera. Better to say so than to return a square of somewhere else.
 */
export function regionToCrop({ region, homography, lensCalibration, crop, frame }: CropInput): CropRect | null {
  const inverse = invertMatrix3x3(homography);
  if (!inverse) return null;

  const k1 = sliderValueToLensK1(lensCalibration);
  const useLens = Math.abs(k1) >= 1e-12;
  const half = region.size / 2;

  const xs: number[] = [];
  const ys: number[] = [];
  for (const [nx, ny] of [
    [region.cx - half, region.cy - half],
    [region.cx + half, region.cy - half],
    [region.cx + half, region.cy + half],
    [region.cx - half, region.cy + half],
  ] as const) {
    const board: Point2D = [nx * BOARD_MAX, ny * BOARD_MAX];
    const undistorted = transformPoint(board, inverse);
    if (!undistorted) return null;
    // Back through the lens the same way the tips came out of it, so a calibrated camera's crop
    // lands where the dart actually is rather than where an ideal lens would have put it.
    const normalized = useLens ? distortNormalizedPoint(undistorted, k1) : undistorted;
    xs.push(crop.cropX + normalized[0] * crop.cropSize);
    ys.push(crop.cropY + normalized[1] * crop.cropSize);
  }

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) return null;

  // Square, because every still is square and stretching one axis would misrepresent the board.
  const side = Math.max(maxX - minX, maxY - minY);
  if (side <= 0) return null;

  return clampToFrame({
    x: (minX + maxX) / 2 - side / 2,
    y: (minY + maxY) / 2 - side / 2,
    size: side,
  }, frame);
}

/**
 * Keep the square inside the picture, by sliding it rather than shrinking it.
 *
 * The same instinct as `clampRegion`: a dart near the edge of the frame should give the closest
 * square that still holds it, at the size that was asked for. Only a square larger than the frame
 * itself is cut down, because there is nothing else to do with it.
 */
function clampToFrame(rect: CropRect, frame: { width: number; height: number }): CropRect {
  const size = Math.min(rect.size, frame.width, frame.height);
  return {
    x: Math.min(Math.max(rect.x, 0), Math.max(0, frame.width - size)),
    y: Math.min(Math.max(rect.y, 0), Math.max(0, frame.height - size)),
    size,
  };
}

// ============================================================
// The one canvas every still is taken on
// ============================================================

/**
 * Draw on the CPU rather than the GPU.
 *
 * The argument for `true`: this canvas is written once and read back once and never composited,
 * which is the case `willReadFrequently` exists for, and what the preprocessing canvas in model.ts
 * already asks for. A GPU-backed canvas has to stall for a readback before it can be encoded, for a
 * length of time that depends on what else is using the GPU — and on a phone also running the
 * detection model, that would be where a still's time went and why it varied.
 *
 * `false` measured faster — in the e2e container, 1–2ms to encode against 1–9ms, and a 9/17/19ms
 * round trip against 15/23/24ms. **That container has no GPU adapter at all**, so it never exercised
 * the stall this flag exists to avoid, and the comparison says nothing about a phone.
 *
 * `true` wins on the argument that outlasts the measurement: at a round trip of roughly twenty
 * milliseconds nobody can feel the difference, and the scarce resource on a scoring device is not
 * those milliseconds — it is the GPU the detection model is using. A photograph has no business
 * competing for it.
 *
 * Still a knob, and the way to settle it on real hardware is the diagnostics panel: throw darts and
 * read `capture · wait/draw/encode`. **Look at the spread, not the median** — a readback stalling
 * behind inference is an occasional slow capture, not a uniformly slower one.
 */
const DRAW_ON_CPU = true;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type AnyContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

let canvas: AnyCanvas | null = null;
let context: AnyContext | null = null;
let canvasSize = 0;

/**
 * The still canvas, made once and kept.
 *
 * It used to be created per capture — a fresh DOM node and a fresh backing store for every
 * photograph, which on a burst of three darts was three of each. Same arrangement as
 * `ensurePreprocessingResources` in model.ts, for the same reason: the only thing a capture should
 * allocate is the picture it returns.
 */
function ensureCanvas(size: number): AnyContext | null {
  if (!canvas) {
    canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(size, size)
      : document.createElement('canvas');
  }
  if (canvasSize !== size) {
    canvas.width = size;
    canvas.height = size;
    canvasSize = size;
    // A resize drops the context's state on some engines; taking it again is cheaper than being
    // wrong about which ones.
    context = null;
  }
  if (!context) {
    context = canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: DRAW_ON_CPU,
    }) as AnyContext | null;
  }
  return context;
}

/** How long the two halves of a capture took. Only read where the e2e seam is open. */
export interface CaptureTiming {
  drawMs: number;
  encodeMs: number;
}

export interface Capture {
  blob: Blob;
  timing: CaptureTiming;
}

/**
 * Cut the square out of a live frame and encode it.
 *
 * Drawn straight from the `<video>` element rather than from anything the inference kept: this is
 * the freshest picture the camera has, and by the time a request has crossed a peer connection the
 * dart it is about has been in the board for a moment already.
 *
 * The draw is one call — `drawImage` with a source rectangle crops and scales in a single operation,
 * straight into a canvas that is already the still's size, so there is no second pass and nothing to
 * position. The encode is the expensive half.
 */
export async function captureCrop(
  source: CanvasImageSource,
  rect: CropRect,
  size: number,
  mime: string,
  quality: number,
): Promise<Capture | null> {
  const ctx = ensureCanvas(size);
  if (!ctx) return null;

  const startedAt = performance.now();
  ctx.drawImage(source, rect.x, rect.y, rect.size, rect.size, 0, 0, size, size);
  const drawnAt = performance.now();

  // Bound to a local so the check below narrows it; a property access is not a narrowable reference.
  const target: AnyCanvas = ctx.canvas;
  const blob = 'convertToBlob' in target
    ? await target.convertToBlob({ type: mime, quality })
    : await new Promise<Blob | null>((resolve) => target.toBlob(resolve, mime, quality));

  if (!blob) return null;
  return {
    blob,
    timing: { drawMs: drawnAt - startedAt, encodeMs: performance.now() - drawnAt },
  };
}

/** Where the model's input square sits in this frame — the same crop the pipeline feeds the model. */
export function frameGeometry(video: HTMLVideoElement) {
  const { cropX, cropY, cropSize, sourceWidth, sourceHeight } = getCenterSquareCrop(video);
  return { crop: { cropX, cropY, cropSize }, frame: { width: sourceWidth, height: sourceHeight } };
}
