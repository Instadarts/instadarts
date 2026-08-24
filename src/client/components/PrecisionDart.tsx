import type { DartThrow } from '../../shared/types';
import { SECTOR_ORDER } from './boardGeometry';

interface PrecisionDartProps {
  tip: { x: number; y: number };
  viewportSize: number;
  dart: DartThrow;
}

/**
 * A bright counterpart to the bed under the live tip.
 *
 * Singles take the bed's own black or cream, a shade off it either way so the flight still reads as
 * a flight rather than as a hole in the board. Doubles, triples and bulls use saturated red/green,
 * while a miss gets orange of its own.
 */
function flightColorAt(dart: DartThrow): string {
  if (dart.score.label === 'miss') return '#ff9f1c';
  if (dart.score.label === 'DB') return '#ff335f';
  if (dart.score.label === 'SB') return '#20f28c';

  const sectorIndex = SECTOR_ORDER.indexOf(dart.score.base);
  if (sectorIndex < 0) return '#ff9f1c';
  if (dart.score.mult === 2 || dart.score.mult === 3) {
    return sectorIndex % 2 === 0 ? '#ff335f' : '#20f28c';
  }
  return sectorIndex % 2 === 0 ? '#363a41' : '#fcedc2';
}

/**
 * A screen-sized dart whose foremost pixel is the scoring coordinate.
 *
 * Every measurement is relative to the current viewBox, so the dart stays the same physical size on
 * screen even though the board underneath it is enlarged. The final factor is its deliberate 50%
 * visual exaggeration.
 *
 * **It stands upright, point down, and every coordinate below is written that way** — the tip at
 * 0/0 and the dart above it in negative y, so the scoring point needs no rotation to arrive at the
 * origin and can be read straight off the path data. What that costs is worth knowing: the tip sits
 * down and right of the finger, so a dart lying back along that diagonal would hide only board the
 * finger was covering anyway, where an upright one crosses fresh board above the tip. It is the
 * clearer read of the two regardless, because a dart standing in a board is what the thing being
 * aimed actually looks like, and because nothing of the bed under the point is covered at all.
 *
 * It is drawn as a real dart rather than as a symbol, to sit on a board that is now drawn as a real
 * board: a steel point, a knurled tungsten barrel and a nylon shaft, each with the cylinder shading
 * a turned metal part has, lit from up and to the left where the board's own sheen comes from.
 *
 * Two things are not realism and must survive any redraw of it. Every part carries a white outline,
 * because the dart has to be legible over a cream bed and a near-black one alike. And both flight
 * surfaces are flat fills of `flightColorAt` — no gradient, no per-wing tint — because that colour
 * is the live read-out of what is about to be scored, and shading it would make two of them.
 */
export function PrecisionDart({ tip, viewportSize, dart }: PrecisionDartProps) {
  const unit = (viewportSize / 100) * 1.5;
  const flightColor = flightColorAt(dart);

  /** Dart-lengths into view units. Everything below is written in the former. */
  const u = (n: number) => n * unit;

  return (
    <g
      data-testid="precision-dart"
      data-board-x={dart.x}
      data-board-y={dart.y}
      data-score={dart.score.label}
      data-flight-color={flightColor}
      transform={`translate(${tip.x} ${tip.y})`}
      pointerEvents="none"
      style={{ filter: `drop-shadow(${u(0.5)}px ${u(0.9)}px ${u(0.7)}px rgb(0 0 0 / 0.8))` }}
    >
      <title>The needle point is the position that will be scored</title>

      <defs>
        {/* Three turned cylinders, each shaded across its own width: the bright band sits left of
            centre and both edges fall away, which is what tells the eye the part is round rather
            than a flat strip. Bounding-box units, so one gradient serves parts of any width. */}
        <linearGradient id="pd-steel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#565e67" />
          <stop offset="0.36" stopColor="#ccd4dc" />
          <stop offset="0.68" stopColor="#767e88" />
          <stop offset="1" stopColor="#3b424a" />
        </linearGradient>
        <linearGradient id="pd-tungsten" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#20242a" />
          <stop offset="0.3" stopColor="#98a1ab" />
          <stop offset="0.48" stopColor="#e2e8ee" />
          <stop offset="0.72" stopColor="#737b85" />
          <stop offset="1" stopColor="#181b20" />
        </linearGradient>
        <linearGradient id="pd-shaft" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#111419" />
          <stop offset="0.36" stopColor="#4d545e" />
          <stop offset="0.6" stopColor="#262b32" />
          <stop offset="1" stopColor="#090b0e" />
        </linearGradient>
      </defs>

      {/* Point. The apex is the scoring coordinate and is the one number here that cannot move.
          Darker steel than the eye expects, and a thinner outline than the rest of the dart carries,
          because the part that matters most is also the thinnest: on a part this narrow a normal
          outline meets itself across the middle, and a bright fill behind it leaves the point
          white-on-cream at the one place the player is actually looking. */}
      <path
        data-dart-outline=""
        d={`M 0 0 L ${u(-0.42)} ${u(-6.9)} L ${u(0.42)} ${u(-6.9)} Z`}
        fill="url(#pd-steel)"
        stroke="#ffffff"
        strokeWidth={u(0.12)}
      />
      <path
        d={`M ${u(-0.08)} ${u(-1.4)} L ${u(-0.16)} ${u(-6.3)}`}
        fill="none"
        stroke="#ffffff"
        strokeWidth={u(0.11)}
        opacity="0.55"
      />

      {/* Barrel: a torpedo, shouldered at both ends and ring-cut across the grip. */}
      <path
        data-dart-outline=""
        d={[
          `M ${u(-0.5)} ${u(-6.6)}`,
          `L ${u(-1.32)} ${u(-8.7)}`,
          `L ${u(-1.32)} ${u(-14.2)}`,
          `L ${u(-0.66)} ${u(-16.4)}`,
          `L ${u(0.66)} ${u(-16.4)}`,
          `L ${u(1.32)} ${u(-14.2)}`,
          `L ${u(1.32)} ${u(-8.7)}`,
          `L ${u(0.5)} ${u(-6.6)} Z`,
        ].join(' ')}
        fill="url(#pd-tungsten)"
        stroke="#ffffff"
        strokeWidth={u(0.26)}
      />
      {[9.3, 10.1, 10.9, 11.7, 12.5, 13.3].map((y) => (
        <path
          key={y}
          d={`M ${u(-1.26)} ${u(-y)} L ${u(1.26)} ${u(-y)}`}
          fill="none"
          stroke="#0e1116"
          strokeWidth={u(0.17)}
          opacity="0.5"
        />
      ))}
      {/* The lit edge of the grip, which the ring cuts would otherwise flatten out. */}
      <path
        d={`M ${u(-0.72)} ${u(-8.9)} L ${u(-0.72)} ${u(-14.1)}`}
        fill="none"
        stroke="#ffffff"
        strokeWidth={u(0.2)}
        opacity="0.45"
      />

      {/* Shaft, with the collar it screws into the barrel by. */}
      <path
        data-dart-outline=""
        d={`M ${u(-0.52)} ${u(-16.2)} L ${u(-0.58)} ${u(-20.9)} L ${u(0.58)} ${u(-20.9)} L ${u(0.52)} ${u(-16.2)} Z`}
        fill="url(#pd-shaft)"
        stroke="#ffffff"
        strokeWidth={u(0.2)}
      />
      <path
        d={`M ${u(-0.6)} ${u(-16.9)} L ${u(0.6)} ${u(-16.9)}`}
        fill="none"
        stroke="#e8edf2"
        strokeWidth={u(0.26)}
        opacity="0.55"
      />

      {/* Flights. Two wings splayed off the shaft, the near edge of each swept out and the rear
          cut back, which is the silhouette a standard flight makes from side on. */}
      <path
        data-dart-outline=""
        data-flight-surface=""
        d={[
          `M ${u(-0.2)} ${u(-20.1)}`,
          `C ${u(-2.05)} ${u(-21.9)} ${u(-3.15)} ${u(-23.5)} ${u(-3.3)} ${u(-25.2)}`,
          `L ${u(-2.7)} ${u(-28.8)}`,
          `L ${u(-0.2)} ${u(-26.2)} Z`,
        ].join(' ')}
        fill={flightColor}
        stroke="#ffffff"
        strokeWidth={u(0.28)}
      />
      <path
        data-dart-outline=""
        data-flight-surface=""
        d={[
          `M ${u(0.2)} ${u(-20.1)}`,
          `C ${u(2.05)} ${u(-21.9)} ${u(3.15)} ${u(-23.5)} ${u(3.3)} ${u(-25.2)}`,
          `L ${u(2.7)} ${u(-28.8)}`,
          `L ${u(0.2)} ${u(-26.2)} Z`,
        ].join(' ')}
        fill={flightColor}
        stroke="#ffffff"
        strokeWidth={u(0.28)}
      />
      {/* The lamp is up-left, so the left wing takes the sheen and the right one the shade. Both
          are laid over the fills rather than mixed into them, so neither surface's own colour is
          altered and the read-out stays one colour. */}
      <path
        d={`M ${u(-0.3)} ${u(-21.0)} C ${u(-1.6)} ${u(-22.4)} ${u(-2.35)} ${u(-23.6)} ${u(-2.6)} ${u(-25.0)} L ${u(-0.3)} ${u(-24.6)} Z`}
        fill="#ffffff"
        opacity="0.26"
      />
      <path
        d={`M ${u(2.15)} ${u(-23.2)} C ${u(2.9)} ${u(-24.0)} ${u(3.25)} ${u(-24.5)} ${u(3.3)} ${u(-25.2)} L ${u(2.7)} ${u(-28.8)} L ${u(1.5)} ${u(-27.5)} Z`}
        fill="#05070a"
        opacity="0.26"
      />
      {/* The fold the two wings meet along. */}
      <path
        d={`M 0 ${u(-20.3)} L 0 ${u(-26.6)}`}
        fill="none"
        stroke="#ffffff"
        strokeWidth={u(0.16)}
        opacity="0.6"
      />
    </g>
  );
}
