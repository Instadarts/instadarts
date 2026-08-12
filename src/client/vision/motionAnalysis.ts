// The pure passes of motion detection: greyscale, Gaussian blur, difference, count per tile.
//
// No DOM, no GPU, no state — the same arithmetic the compute shader performs, kept here so the CPU
// path has one home and so both can be tested against known pixels. The WebGPU analyzer in
// motion.ts reimplements these in WGSL; if you change one, change both, and check the tests still
// agree.
//
// The numbers these work from are measurements against real boards and phones. Do not retune.
//
// Noise reduction: a 5×5 separable Gaussian blur [1,4,6,4,1] applied *before* frame differencing.
// This is the Android-proven strategy — it integrates more spatial context than the old
// dilate+erode morphology and avoids the blind spot where a dart edge pixel just below the
// threshold is unrecoverably lost.

/** The tuning. Every field here was measured, not chosen. */
export interface MotionDefaults {
  gridRows: number;
  gridCols: number;
  tileChangePercent: number;
  minTiles: number;
  maxTiles: number;
  pixelThreshold: number;
  /** Multiplier at brightness extremes (0 / 255).  Mid-grey (128) always uses 1.0.  < 1.0 makes the detector more sensitive in shadows and highlights. */
  pixelThresholdMult: number;
  analyzeSize: number;
  quietTimeMs: number;
  quietFrames: number;
  largeMotionQuietMultiplier: number;
}

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let src = 0, dst = 0; src < rgba.length; src += 4, dst += 1) {
    out[dst] = Math.round(rgba[src] * 0.299 + rgba[src + 1] * 0.587 + rgba[src + 2] * 0.114);
  }
  return out;
}

/**
 * 5×5 separable Gaussian blur with the binomial kernel [1, 4, 6, 4, 1].
 *
 * The kernel is applied as two 1D passes (horizontal then vertical), each reading 5 taps per
 * output pixel.  The sum of weights is 16 in one dimension, so the two-pass combined
 * normalisation is ÷256.  Border pixels clamp to the edge — the kernel is not truncated.
 */
export function gaussianBlur(input: Uint8Array, size: number): Uint8Array {
  const temp = new Int32Array(input.length);  // 5×255×16 < 2^15, fits in i32

  // Horizontal pass [1, 4, 6, 4, 1]
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * size;
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      // -2, -1, 0, +1, +2  with weights 1, 4, 6, 4, 1
      for (let ox = -2; ox <= 2; ox += 1) {
        const xi = Math.max(0, Math.min(size - 1, x + ox));
        const weight = ox === 0 ? 6 : ox === -1 || ox === 1 ? 4 : 1;
        sum += (input[rowOffset + xi] & 0xff) * weight;
      }
      temp[rowOffset + x] = sum;
    }
  }

  // Vertical pass [1, 4, 6, 4, 1]
  const out = new Uint8Array(input.length);
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      let sum = 0;
      for (let oy = -2; oy <= 2; oy += 1) {
        const yi = Math.max(0, Math.min(size - 1, y + oy));
        const weight = oy === 0 ? 6 : oy === -1 || oy === 1 ? 4 : 1;
        sum += temp[yi * size + x] * weight;
      }
      out[y * size + x] = Math.round(sum / 256);
    }
  }

  return out;
}

/**
 * Per-pixel absolute-difference mask thresholded at `pixelThreshold`.
 *
 * Both `previous` and `current` are expected to already be blurred — the caller applies
 * `gaussianBlur` before calling this and before storing the frame for the next pass.
 */
export function diffMask(previous: Uint8Array, current: Uint8Array, defaults: MotionDefaults): Uint8Array {
  const mask = new Uint8Array(current.length);
  const mult = defaults.pixelThresholdMult;
  const invRange = 1 - mult;  // precompute (1 - pixelThresholdMult)
  for (let i = 0; i < current.length; i += 1) {
    // Parabolic threshold: 1.0 at mid-grey (128), pixelThresholdMult at 0 / 255.
    // Uses *previous* pixel — the board background (black/white extremes) gets
    // a lower threshold so a mid-grey dart tip landing on it is detected more easily.
    const t = ((previous[i] & 0xff) - 128) / 128;  // [-1, 1]
    const factor = 1 - invRange * t * t;
    const threshold = defaults.pixelThreshold * factor;
    if (Math.abs((current[i] & 0xff) - (previous[i] & 0xff)) >= threshold) {
      mask[i] = 1;
    }
  }
  return mask;
}

export function fillTileCounts(mask: Uint8Array, tileCounts: Uint32Array, defaults: MotionDefaults): void {
  const size = defaults.analyzeSize;
  const tileHeight = size / defaults.gridRows;
  const tileWidth = size / defaults.gridCols;
  for (let row = 0; row < defaults.gridRows; row += 1) {
    const y0 = Math.floor(row * tileHeight);
    const y1 = Math.floor((row + 1) * tileHeight);
    for (let col = 0; col < defaults.gridCols; col += 1) {
      const x0 = Math.floor(col * tileWidth);
      const x1 = Math.floor((col + 1) * tileWidth);
      let changed = 0;
      for (let y = y0; y < y1; y += 1) {
        const base = y * size;
        for (let x = x0; x < x1; x += 1) {
          if (mask[base + x]) changed += 1;
        }
      }
      tileCounts[row * defaults.gridCols + col] = changed;
    }
  }
}
