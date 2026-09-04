// A QR symbol, drawn.
//
// SVG rather than canvas, because the thing being drawn is a grid of hard-edged squares at whatever
// size the layout gives it: a canvas would have to be told a pixel size and redrawn when that
// changed, and would resample badly on a high-density screen. One `<path>` of rectangles scales to
// anything and costs one element.
//
// **Always dark-on-white, never themed.** Everything else in this app follows the dark theme; this
// deliberately does not. A camera hunting for a symbol wants the contrast it was designed for, and
// while many scanners cope with an inverted symbol, not all do — and the one that does not is
// somebody's phone rather than ours to fix.

import { encodeQr } from '../lib/qr';

interface QrCodeProps {
  /** What the symbol should say. Typically a url. */
  text: string;
  /** Rendered width and height, in pixels. */
  size?: number;
  className?: string;
}

/**
 * Modules of white margin around the symbol.
 *
 * Four is what the standard requires, and it is not decoration: a scanner finds the symbol by
 * looking for the finder patterns against clear space, and a symbol butted against other content
 * is one many readers will not see at all.
 */
const QUIET_ZONE = 4;

/**
 * Renders `text` as a QR symbol, or nothing at all if it will not fit.
 *
 * Returning null rather than throwing is the whole reason `encodeQr` can answer null: this is an
 * accelerator for a pairing code that is also printed beside it in full, so a payload too long for
 * the encoder costs the user a few seconds of typing rather than an error they can do nothing with.
 */
export function QrCode({ text, size = 200, className = '' }: QrCodeProps) {
  const qr = encodeQr(text);
  if (!qr) return null;

  const span = qr.size + QUIET_ZONE * 2;

  // One path, one rectangle per dark module. `shape-rendering="crispEdges"` matters more than it
  // looks: antialiasing along a module boundary is exactly the grey a thresholding scanner has to
  // guess about, and at small sizes that guess is the difference between a read and a shrug.
  let path = '';
  for (let row = 0; row < qr.size; row++) {
    for (let col = 0; col < qr.size; col++) {
      if (qr.modules[row][col]) path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
  }

  return (
    <svg
      viewBox={`0 0 ${span} ${span}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label="Pairing code, as a QR code"
    >
      <rect width={span} height={span} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
