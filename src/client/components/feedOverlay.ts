// What a recorded board feed says about the match it was recording.
//
// A camera sends a picture of a board and nothing else — it does not know whose throw it is, what
// the score was, or what the dart it just watched land was worth. A clip of one is therefore a
// picture of a dartboard with no story attached, and a person watching it back has to remember.
// This draws the story on.
//
// It composites, rather than being drawn into the feed: the receiver's canvas holds the decoded
// picture untouched, and everything here goes onto a second one. That keeps the recorded overlay out
// of anything that reads the raw picture — `__media.frame()`, and the fingerprints the director
// tests compare — and it means the overlay can animate between video frames instead of only when one
// happens to arrive.

/** What the match looks like at the moment a frame is composited. */
export interface OverlayState {
  /** Whose throw it is. */
  player: string;
  /** Their score, as the mode words it — "Bust!" is a score as far as this is concerned. */
  score: string;
  /** The visit so far, one label per dart: `T20`, `5`, `D10`. */
  darts: string[];
}

/**
 * How long a dart's label stays on screen.
 *
 * A second, and not more on purpose: it is a flourish over a live picture, and a flourish that
 * outlasts the next throw stops being one. Most of that second is spent at a size you can read —
 * see `flashShape`, which is where the useful part of the duration is actually decided.
 */
export const FLASH_MS = 1000;

/** The flash, part-way through. Null once it is over — nothing to draw and nothing to schedule. */
export interface Flash {
  label: string;
  /** 0 at the start, 1 at the end. */
  progress: number;
}

export function flashAt(startedAt: number, now: number, label: string): Flash | null {
  const progress = (now - startedAt) / FLASH_MS;
  if (progress < 0 || progress >= 1) return null;
  return { label, progress };
}

/**
 * Where the flash is at, in the two dimensions it moves in.
 *
 * Separated from the drawing because it is the part with an opinion in it, and the part worth
 * checking without a canvas: it begins at most of the frame and leaves well outside it, at three
 * quarters opacity fading to nothing. Growing *out* of the frame rather than settling in it is what
 * stops it reading as a caption.
 *
 * **Both curves are weighted towards the start, which is the whole trick.** The obvious shaping —
 * ease the growth out, fade linearly — spends its motion budget immediately: the label is past a
 * readable size within a tenth of a second and half transparent by the midpoint, so a second of
 * animation contains barely a tenth of a second of legible label. Easing the growth *in* instead
 * holds it near its starting size for most of the duration and then throws it off the screen, and
 * squaring the fade keeps it opaque while that is happening. The flash is the same length and the
 * same shape; almost all of it is now the readable part.
 */
export function flashShape(progress: number): { scale: number; alpha: number } {
  const t = Math.min(Math.max(progress, 0), 1);
  return {
    // Cubic ease-in: barely moves for the first half, then leaves quickly.
    scale: 1 + 1.7 * t ** 3,
    // Squared, so it holds its opacity through the readable part and drops away with the exit —
    // still thinnest exactly when it is largest.
    alpha: 0.75 * (1 - t ** 2),
  };
}

const SCRIM = 'rgba(0, 0, 0, 0.45)';

/**
 * One composited frame: the picture, then everything above it.
 *
 * Sized in fractions of the canvas rather than in pixels, because the profile's size is a deployment
 * decision and text that was legible at 320 should not become a smear at 240 or a stamp at 480.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  size: number,
  state: OverlayState,
  flash: Flash | null,
): void {
  const pad = Math.round(size * 0.035);
  const line = Math.round(size * 0.065);
  /**
   * How tall a band is, as a multiple of the text in it.
   *
   * Barely more than the text needs. A band over a live picture is covering something somebody wants
   * to see, so the padding is the part to be mean with — and the text is not, which is why this is a
   * multiple of the line rather than a size of its own.
   */
  const bar = line * 1.36;
  /** Derived rather than written down twice, so a band and the text in it cannot drift apart. */
  const middle = bar / 2;

  ctx.save();
  ctx.textBaseline = 'middle';

  // Scrims rather than shadows. A dartboard is busy and high-contrast in patches, so text over one
  // is legible in some places and not others; a band is legible everywhere.
  ctx.fillStyle = SCRIM;
  ctx.fillRect(0, 0, size, bar);
  if (state.darts.length > 0) ctx.fillRect(0, size - bar, size, bar);

  ctx.font = `600 ${line}px system-ui, sans-serif`;
  ctx.fillStyle = '#fff';

  ctx.textAlign = 'left';
  ctx.fillText(state.player, pad, middle, size * 0.6);

  ctx.textAlign = 'right';
  ctx.fillText(state.score, size - pad, middle, size * 0.35);

  if (state.darts.length > 0) {
    ctx.font = `500 ${Math.round(line * 0.9)}px ui-monospace, monospace`;
    // One slot per dart of a visit, always three wide so a first dart sits where a first dart sits
    // rather than sliding as the visit fills — the same arrangement as the dart slots on the match
    // screen. Centred in its own slot, which is what makes three of them read as a row.
    const step = (size - pad * 2) / Math.max(state.darts.length, 3);
    ctx.textAlign = 'center';
    state.darts.forEach((label, i) => {
      ctx.fillText(label, pad + step * (i + 0.5), size - middle, step);
    });
  }

  if (flash) {
    const { scale, alpha } = flashShape(flash.progress);
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(size * 0.42 * scale)}px system-ui, sans-serif`;
    // Stroked as well as filled: by the time it is large and faint it lies over half the board, and
    // an outline is what keeps it readable against a picture rather than a colour.
    ctx.lineWidth = Math.max(2, size * 0.012 * scale);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillStyle = '#fff';
    ctx.strokeText(flash.label, size / 2, size / 2);
    ctx.fillText(flash.label, size / 2, size / 2);
  }

  ctx.restore();
}
