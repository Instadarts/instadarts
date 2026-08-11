// The virtual camera: a square of the frame that can be told to move somewhere else, and takes a
// moment doing it.
//
// There is no second lens and no zoom motor. The whole thing is the source rectangle of a
// `drawImage` — the same call `captureCrop` makes for a still — with its four numbers interpolated
// between where they were and where they are going. A "camera move" is a lerp.
//
// ## Why not CSS
//
// The obvious-looking version of this is to draw the camera into a canvas and let a CSS transition
// animate a transform over it. It cannot work: a transform on a `<canvas>` or `<video>` changes only
// how the browser composites that **element** into the page, and never the bitmap. `drawImage`,
// `new VideoFrame(canvas)` and `captureStream()` all read the bitmap, so an encoder fed from any of
// them would receive the untransformed picture. Nothing rasterizes a CSS-transformed subtree at
// fifteen frames a second.
//
// Which turns out not to matter, because the arithmetic CSS would have done for us is the two pure
// functions below.
//
// ## What this file does not know
//
// Where the board is. The destination rectangle is handed in on every frame by whoever owns the
// homography (visionRuntime), which is what lets the shot **upgrade itself**: a feed that starts
// before the board has been located frames the camera's own square, and slides to the board the
// moment a homography exists, with no state machine and nothing to notify.

import type { CropRect } from './stillCapture';

/**
 * Cubic ease-in-out, clamped.
 *
 * Slow at both ends and quick through the middle, which is what a camera operator's hand does and
 * what a linear ramp conspicuously does not. Clamped rather than extrapolating, so a caller that
 * hands over a stale clock gets the end of the move instead of a shot beyond it.
 */
export function easeInOut(t: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2;
}

/**
 * Part-way between two squares.
 *
 * Interpolated by **centre and size**, not by corner and size. The two agree only when the sizes
 * match: lerping a corner through a pure zoom slides the picture sideways as it shrinks, because the
 * corner has to travel while the centre does not. Centre-first is the zoom anyone would expect.
 */
export function lerpCrop(a: CropRect, b: CropRect, t: number): CropRect {
  const size = a.size + (b.size - a.size) * t;
  const cx = (a.x + a.size / 2) + ((b.x + b.size / 2) - (a.x + a.size / 2)) * t;
  const cy = (a.y + a.size / 2) + ((b.y + b.size / 2) - (a.y + a.size / 2)) * t;
  return { x: cx - size / 2, y: cy - size / 2, size };
}

export interface VirtualCamera {
  /**
   * Take this long to get to wherever `destination` is pointing from now on.
   *
   * The region itself is not held here — the caller resolves it to a rectangle every frame. This
   * only starts the clock, and snapshots the shot the move is leaving from.
   */
  move(transitionMs: number): void;
  /**
   * The square to draw this frame: `destination` once the move is over, somewhere on the way there
   * until then.
   */
  shot(destination: CropRect, now: number): CropRect;
  /** Whether a move is still in progress, for anything that wants to know the picture is settling. */
  moving(now: number): boolean;
  /** Forget where we were. The next shot cuts straight to its destination. */
  reset(): void;
}

export function createVirtualCamera(): VirtualCamera {
  /** The last square actually drawn — what a move departs from. Null before the first frame. */
  let last: CropRect | null = null;
  let from: CropRect | null = null;
  let startedAt = 0;
  let durationMs = 0;

  return {
    move(transitionMs: number): void {
      // Nothing to move from yet: the first shot of a feed is wherever it is pointed, instantly.
      // Animating out of a rectangle we invented would be a swoop from nowhere.
      if (!last) return;
      from = last;
      startedAt = performance.now();
      durationMs = Math.max(0, transitionMs);
    },

    shot(destination: CropRect, now: number): CropRect {
      if (!from || durationMs <= 0) {
        from = null;
        last = destination;
        return destination;
      }

      const t = (now - startedAt) / durationMs;
      if (t >= 1) {
        from = null;
        last = destination;
        return destination;
      }

      // `destination` is re-resolved by the caller on every frame, so a move that starts before the
      // board is located still lands on the board: the target moves under the animation and the
      // easing carries the picture to wherever it ended up.
      const rect = lerpCrop(from, destination, easeInOut(t));
      last = rect;
      return rect;
    },

    moving(now: number): boolean {
      return from !== null && durationMs > 0 && now - startedAt < durationMs;
    },

    reset(): void {
      last = null;
      from = null;
      durationMs = 0;
    },
  };
}

// ============================================================
// The canvas the feed is drawn on
// ============================================================

/**
 * Its own canvas, deliberately not the still canvas next door.
 *
 * That one asks for `willReadFrequently` because `toBlob` reads it straight back, and the argument
 * for it is written out in `stillCapture.ts`. This one is the opposite case: it is written and then
 * handed to `new VideoFrame(...)`, which wants the pixels where the encoder is. Asking for a CPU
 * canvas here would buy a readback we do not want and an upload we would then pay for.
 *
 * Made once and kept, like every other drawing resource in this directory.
 */
let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
let canvasSize = 0;

function ensureCanvas(size: number) {
  if (!canvas) {
    canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(size, size)
      : document.createElement('canvas');
  }
  if (canvasSize !== size) {
    canvas.width = size;
    canvas.height = size;
    canvasSize = size;
    context = null;
  }
  if (!context) {
    context = canvas.getContext('2d', { alpha: false }) as
      OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  }
  return context;
}

/**
 * Draw one shot and hand it over as a frame the encoder can take.
 *
 * The caller closes it. A `VideoFrame` holds a real buffer — on some platforms a GPU texture — and
 * leaking them stalls the encoder within a second or two rather than growing slowly like an ordinary
 * leak.
 */
export function grabFrame(
  source: CanvasImageSource,
  rect: CropRect,
  size: number,
  timestampUs: number,
  durationUs: number,
): VideoFrame | null {
  const ctx = ensureCanvas(size);
  if (!ctx) return null;
  try {
    ctx.drawImage(source, rect.x, rect.y, rect.size, rect.size, 0, 0, size, size);
    return new VideoFrame(ctx.canvas, { timestamp: timestampUs, duration: durationUs });
  } catch {
    // A video element between frames, or a source the platform will not draw yet. The next tick
    // brings another one, and a dropped frame is the cheapest failure this pipeline has.
    return null;
  }
}

/** The canvas the virtual camera draws onto, for debugging. Null when no frame has been drawn yet. */
export function getCameraCanvas(): OffscreenCanvas | HTMLCanvasElement | null {
  return canvas;
}

/** Let go of the canvas — a feed that has stopped should not hold a surface open. */
export function releaseCanvas(): void {
  canvas = null;
  context = null;
  canvasSize = 0;
}
