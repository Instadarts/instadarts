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
 * Singles retain the board's black/cream distinction as cool silver and warm yellow. Doubles,
 * triples and bulls use saturated red/green, while a miss gets orange of its own.
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
  return sectorIndex % 2 === 0 ? '#a5afbf' : '#ffe7a0';
}

/**
 * A screen-sized dart whose foremost pixel is the scoring coordinate.
 *
 * Every measurement is relative to the current viewBox, so the dart stays the same physical size
 * on screen even though the board underneath it is enlarged. The final factor is its deliberate
 * 50% visual exaggeration.
 */
export function PrecisionDart({ tip, viewportSize, dart }: PrecisionDartProps) {
  const unit = (viewportSize / 100) * 1.5;
  const flightColor = flightColorAt(dart);

  return (
    <g
      data-testid="precision-dart"
      data-board-x={dart.x}
      data-board-y={dart.y}
      data-score={dart.score.label}
      data-flight-color={flightColor}
      transform={`translate(${tip.x} ${tip.y})`}
      pointerEvents="none"
      style={{ filter: 'drop-shadow(2px 3px 2px rgb(0 0 0 / 0.85))' }}
    >
      <title>The needle point is the position that will be scored</title>

      {/* The point faces down-right while the barrel recedes up-left, giving the dart the
          exaggerated bottom-right viewpoint of a dart hanging tip-down in the board. */}
      <g transform="rotate(144)">
        {/* Needle: the foremost point remains exactly at 0/0 after rotation. */}
        <path
          data-dart-outline=""
          d={`M 0 0 L ${-0.62 * unit} ${6.8 * unit} L ${0.82 * unit} ${6.8 * unit} Z`}
          fill="#f3f4f6"
          stroke="#ffffff"
          strokeWidth={0.26 * unit}
        />
        <path
          d={`M ${0.08 * unit} ${0.8 * unit} L ${0.3 * unit} ${6.35 * unit}`}
          fill="none"
          stroke="#ffffff"
          strokeWidth={0.22 * unit}
        />

        {/* The widening barrel and unequal facets create the bottom-right viewing perspective. */}
        <path
          data-dart-outline=""
          d={`M ${-1.25 * unit} ${6.25 * unit} L ${-2.25 * unit} ${14.3 * unit} L ${0.35 * unit} ${16.2 * unit} L ${2.35 * unit} ${14.05 * unit} L ${1.2 * unit} ${6.25 * unit} Z`}
          fill="#9ca3af"
          stroke="#ffffff"
          strokeWidth={0.34 * unit}
        />
        <path
          d={`M 0 ${6.45 * unit} L ${0.35 * unit} ${15.75 * unit} L ${2.03 * unit} ${13.85 * unit} L ${1.05 * unit} ${6.45 * unit} Z`}
          fill="#f3f4f6"
          opacity="0.9"
        />
        <path
          d={`M ${-1.05 * unit} ${6.45 * unit} L ${-1.95 * unit} ${14.05 * unit} L ${0.1 * unit} ${15.55 * unit} L 0 ${6.45 * unit} Z`}
          fill="#6b7280"
          opacity="0.9"
        />
        {[7.8, 9.45, 11.1, 12.75, 14.4].map((y) => (
          <path
            key={y}
            d={`M ${-1.55 * unit} ${y * unit} L ${1.75 * unit} ${(y - 0.2) * unit}`}
            fill="none"
            stroke="#374151"
            strokeWidth={0.32 * unit}
            opacity="0.8"
          />
        ))}

        {/* Shaft and oversized perspective flights. The near flight is deliberately much larger. */}
        <path
          data-dart-outline=""
          d={`M ${-0.62 * unit} ${15.25 * unit} L ${-0.45 * unit} ${22.2 * unit} L ${0.72 * unit} ${22.2 * unit} L ${0.72 * unit} ${15.2 * unit} Z`}
          fill="#111827"
          stroke="#ffffff"
          strokeWidth={0.28 * unit}
        />
        <path
          data-dart-outline=""
          data-flight-surface=""
          d={`M ${0.15 * unit} ${18.2 * unit} L ${-3.8 * unit} ${21.1 * unit} L ${-2.8 * unit} ${26.2 * unit} L ${0.3 * unit} ${23.8 * unit} Z`}
          fill={flightColor}
          stroke="#ffffff"
          strokeWidth={0.35 * unit}
        />
        <path
          data-dart-outline=""
          data-flight-surface=""
          d={`M ${0.15 * unit} ${18.15 * unit} L ${4.8 * unit} ${20.4 * unit} L ${4.1 * unit} ${27.6 * unit} L ${0.3 * unit} ${23.8 * unit} Z`}
          fill={flightColor}
          stroke="#ffffff"
          strokeWidth={0.42 * unit}
        />
        <path
          d={`M ${0.25 * unit} ${18.2 * unit} L ${1.1 * unit} ${23.9 * unit} L ${0.15 * unit} ${25.9 * unit} Z`}
          fill="#ffffff"
          opacity="0.42"
        />
      </g>
    </g>
  );
}
