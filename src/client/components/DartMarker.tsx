import { CENTER, boardYToSvgY } from './boardGeometry';
import type { DartThrow } from '../../shared/types';

interface DartMarkerProps {
  dart: DartThrow;
  index: number;
}

export function DartMarker({ dart, index }: DartMarkerProps) {
  const cx = dart.x;
  const cy = boardYToSvgY(dart.y);
  const color = dart.score.points > 0 ? '#00ff88' : '#ff4444';

  return (
    <g>
      {/* Outer glow */}
      <circle cx={cx} cy={cy} r="8000" fill="none" stroke={color} strokeWidth="2000" opacity="0.6" />
      {/* Inner marker */}
      <circle cx={cx} cy={cy} r="4000" fill={color} opacity="0.8" />
      {/* Dart number */}
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fill="white"
        fontSize="14"
        fontWeight="bold"
        fontFamily="monospace"
      >
        {index + 1}
      </text>
    </g>
  );
}
