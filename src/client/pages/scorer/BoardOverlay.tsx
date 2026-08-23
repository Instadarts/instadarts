// What the model can see, drawn over the live preview.
//
// The same trick the lens calibration uses (`CalibrationView`'s `Spider`): the geometry comes back
// in normalized image space, and a `viewBox="0 0 1 1"` SVG stretched over a **square** preview is
// that space exactly — no scaling maths, and none to get wrong. It only holds because the model is
// fed a centre square crop and the preview is `object-cover` in a square box; break the aspect ratio
// and this silently slides off the wires.
//
// Louder than the calibration overlay on purpose. That one is a measuring instrument and stays out
// of the way; this one is the answer to "does it work?", read at arm's length across a room.

import type { Point2D } from '../../../shared/vision/types';
import type { SpiderProjection } from '../../vision/lensGeometry';

/** Cyan for the board, orange for the darts. Far enough apart to tell at a glance on a small screen. */
const BOARD_COLOUR = '#22d3ee';
const TIP_COLOUR = '#fb923c';

interface BoardOverlayProps {
  /** Null when too little of the board is visible to place it — then nothing is drawn. */
  spider: SpiderProjection | null;
  tips: Point2D[];
}

export function BoardOverlay({ spider, tips }: BoardOverlayProps) {
  if (!spider) return null;

  return (
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      data-testid="aim-overlay"
    >
      {/* One filter for the whole drawing rather than one per shape. There are twenty-six polylines
          in a spider, and giving each its own blur is a phone-melting amount of re-rasterisation
          five hundred milliseconds apart. */}
      <g style={{ filter: `drop-shadow(0 0 6px ${BOARD_COLOUR})` }}>
        {/* Widths are **fractions of the box**, so they scale with the preview. Not device pixels:
            `vector-effect: non-scaling-stroke` is inert under `preserveAspectRatio="none"`, and a
            width written as though it worked comes out multiplied by the box — 2 fills the screen
            with cyan. Thicker than the calibration overlay's 0.002 hairline on purpose; this one is
            read from across a room rather than leaned into. */}
        <g fill="none" stroke={BOARD_COLOUR}>
          {spider.rings.map((ring, i) => <path key={`r${i}`} d={path(ring)} strokeWidth={0.007} />)}
          {/* The legs sit under the rings: they are the part somebody is not judging alignment by. */}
          {spider.radials.map((radial, i) => <path key={`s${i}`} d={path(radial)} strokeWidth={0.004} opacity={0.6} />)}
        </g>
      </g>

      {/* A wide translucent disc under a small bright one — the halo `DartMarker` already uses, which
          keeps a dot readable over both a white bed and a black one. */}
      <g style={{ filter: `drop-shadow(0 0 4px ${TIP_COLOUR})` }} data-testid="aim-tips">
        {tips.map(([x, y], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r={0.022} fill={TIP_COLOUR} opacity={0.25} />
            <circle cx={x} cy={y} r={0.009} fill={TIP_COLOUR} />
          </g>
        ))}
      </g>
    </svg>
  );
}

/** A polyline as an SVG path. Five decimals is well under a pixel at any preview size. */
function path(points: Point2D[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(' ');
}
