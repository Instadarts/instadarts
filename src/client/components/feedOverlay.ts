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
//
// ## It holds no rules
//
// Every word and every colour here comes from the mode's own `ModeView`, the same one the match
// screen renders — the visit total it already puts under the board, the verdict it already puts on a
// player's card. `overlayFor` is the whole of the translation, and it knows what a bust is only in
// the sense that it can see the mode saying so.

import type { DartThrow, ModeView, Player, TextTone } from '../../shared/types';
import { styleOf, textOf } from '../../shared/types';

/** One dart of the visit, as the strip along the bottom shows it. */
export interface OverlayDart {
  /** `T20`, `5`, `D10` — the mode's wording where it has one. */
  label: string;
  tone: TextTone;
}

/** What the flash says, decided where the match is and frozen for as long as it runs. */
export interface FlashText {
  text: string;
  tone: TextTone;
}

/** What the match looks like at the moment a frame is composited. */
export interface OverlayState {
  /** Whose throw it is. */
  player: string;
  /** Their score, as the mode words it — "Bust!" is a score as far as this is concerned. */
  score: string;
  /** The visit so far, one entry per dart. */
  darts: OverlayDart[];
  /** What to throw across the board when the *next* dart lands. */
  flash: FlashText;
}

/** Nothing to say — no match, or none of it known yet. */
export const NO_OVERLAY: OverlayState = { player: '', score: '', darts: [], flash: { text: '', tone: 'default' } };

/**
 * A `ModeView` and a visit, as the overlay needs them.
 *
 * The two interesting readings:
 *
 *   · **A card score that carries a tone is a verdict, not a number.** An ordinary score is a bare
 *     string; the mode reaches for `StyledText` exactly when the visit is settled and it wants to say
 *     so — "Bust!", "Checkout!". `danger` is the only tone that means the visit came to nothing, so
 *     one comparison separates the two cases and neither string is written down here.
 *   · **The flash is the visit total**, which is the number a person watching a clip back actually
 *     wants: 60, then 120, then 170. A single dart's label is already on the strip below it, and
 *     repeating it enormously in the middle of the board says nothing new. The exceptions are the
 *     three moments where the total is not the news — a dart that scored nothing, a visit thrown
 *     away, a leg won.
 */
export function overlayFor(
  player: Player,
  darts: readonly DartThrow[],
  view: ModeView | null | undefined,
): OverlayState {
  const card = view?.playerScores[player.id];
  const verdict = styleOf(card).tone;
  const busted = verdict === 'danger';
  const finished = verdict !== undefined && !busted;

  const missed = (dart: DartThrow) => dart.score.points === 0;
  const last = darts[darts.length - 1];

  return {
    player: player.name,
    score: textOf(card),
    darts: darts.map((dart, i): OverlayDart => ({
      label: textOf(view?.slots?.[i]) || dart.score.label,
      // The dart that won the leg is the last of a visit the mode has called finished — a leg cannot
      // go on past zero, so there is never a later one to confuse it with.
      tone: finished && i === darts.length - 1 ? 'positive'
        : missed(dart) ? 'danger'
        : 'default',
    })),
    flash: busted ? { text: textOf(card), tone: 'danger' }
      : finished ? { text: textOf(card), tone: 'positive' }
      : last && missed(last) ? { text: 'miss', tone: 'danger' }
      : { text: textOf(view?.visitTotal), tone: 'default' },
  };
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
export interface Flash extends FlashText {
  /** 0 at the start, 1 at the end. */
  progress: number;
}

export function flashAt(startedAt: number, now: number, text: FlashText): Flash | null {
  const progress = (now - startedAt) / FLASH_MS;
  if (progress < 0 || progress >= 1) return null;
  return { ...text, progress };
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
 * What a tone looks like over a board.
 *
 * Three answers to six tones, because over a picture there are only three things worth distinguishing
 * at a glance: this went well, this went badly, this is just the score. Bright rather than saturated —
 * these sit on a scrim over a busy, high-contrast surface, and a deep red on a dark board is a
 * smudge.
 */
export function toneColour(tone: TextTone): string {
  if (tone === 'positive') return '#4ade80';
  if (tone === 'danger') return '#f87171';
  return '#fff';
}

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
    state.darts.forEach((dart, i) => {
      ctx.fillStyle = toneColour(dart.tone);
      ctx.fillText(dart.label, pad + step * (i + 0.5), size - middle, step);
    });
  }

  if (flash && flash.text) {
    const { scale, alpha } = flashShape(flash.progress);
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(size * 0.42 * scale)}px system-ui, sans-serif`;
    // Stroked as well as filled: by the time it is large and faint it lies over half the board, and
    // an outline is what keeps it readable against a picture rather than a colour.
    ctx.lineWidth = Math.max(2, size * 0.012 * scale);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillStyle = toneColour(flash.tone);
    ctx.strokeText(flash.text, size / 2, size / 2);
    ctx.fillText(flash.text, size / 2, size / 2);
  }

  ctx.restore();
}
