import { toSvg } from './boardGeometry';
import type { DartThrow } from '../../shared/types';

interface DartMarkerProps {
  dart: DartThrow;
  index: number;
}

/**
 * Where a dart landed, and which of the visit it was.
 *
 * Sized in SVG units, so the marker is a fixed share of the board however large the board is drawn
 * — and, unlike before, large enough to hold its own number. A real dart's flight is about 20mm
 * across; this is a little under that, so it marks the spot without covering the bed it is in.
 */
const RING = 1.7;
const DOT = 1.4;
const DIGIT = 1.9;

export function DartMarker({ dart, index }: DartMarkerProps) {
  const { x, y } = toSvg(dart);
  const color = dart.score.points > 0 ? '#00ff88' : '#ff4444';

  return (
    <g>
      {/* Outer glow */}
      <circle cx={x} cy={y} r={RING} fill="none" stroke="#000" strokeWidth={0.3} opacity="0.6" />
      {/* Inner marker */}
      <circle cx={x} cy={y} r={DOT} fill={color} stroke="#fff" strokeWidth={0.3} opacity="0.85" />
    </g>
  );
}
