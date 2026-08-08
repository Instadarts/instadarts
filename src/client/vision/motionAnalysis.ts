// The pure passes of motion detection: greyscale, difference, clean up, count per tile.
//
// No DOM, no GPU, no state — the same arithmetic the compute shader performs, kept here so the CPU
// path has one home and so both can be tested against known pixels. The WebGPU analyzer in
// motion.ts reimplements these in WGSL; if you change one, change both, and check the tests still
// agree.
//
// The numbers these work from are measurements against real boards and phones. Do not retune.

/** The tuning. Every field here was measured, not chosen. */
export interface MotionDefaults {
  gridRows: number;
  gridCols: number;
  tileChangePercent: number;
  minTiles: number;
  maxTiles: number;
  pixelThreshold: number;
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

export function diffMask(previous: Uint8Array, current: Uint8Array, defaults: MotionDefaults): Uint8Array {
  const mask = new Uint8Array(current.length);
  for (let i = 0; i < current.length; i += 1) {
    if (Math.abs(current[i] - previous[i]) >= defaults.pixelThreshold) {
      mask[i] = 1;
    }
  }
  return erode(dilate(mask, defaults), defaults);
}

export function dilate(mask: Uint8Array, defaults: MotionDefaults): Uint8Array {
  const size = defaults.analyzeSize;
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let active = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        const yy = y + oy;
        if (yy < 0 || yy >= size) continue;
        const base = yy * size;
        for (let ox = -1; ox <= 1; ox += 1) {
          const xx = x + ox;
          if (xx < 0 || xx >= size) continue;
          active += mask[base + xx];
        }
      }
      if (active >= 2) out[y * size + x] = 1;
    }
  }
  return out;
}

export function erode(mask: Uint8Array, defaults: MotionDefaults): Uint8Array {
  const size = defaults.analyzeSize;
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let active = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        const yy = y + oy;
        if (yy < 0 || yy >= size) { active = 0; break; }
        const base = yy * size;
        for (let ox = -1; ox <= 1; ox += 1) {
          const xx = x + ox;
          if (xx < 0 || xx >= size) { active = 0; break; }
          active += mask[base + xx];
        }
      }
      if (active >= 7) out[y * size + x] = 1;
    }
  }
  return out;
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
