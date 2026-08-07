import { useRef, useCallback } from 'react';
import {
  RADII, CENTER, BOARD_SIZE,
  SECTOR_ORDER,
  getSectorColor, getDoubleTripleColor,
  boardYToSvgY,
} from './boardGeometry';
import { DartMarker } from './DartMarker';
import type { DartThrow } from '../../shared/types';
import { scoreFromBoardCoords } from '../../shared/scoring';

interface DartboardProps {
  darts: DartThrow[];
  /** How many darts the visit may hold. The game mode decides. */
  maxDarts: number;
  onDartClick: (dart: DartThrow) => void;
  disabled?: boolean;
}

/**
 * Generate SVG arc path for a sector ring segment.
 */
function sectorPath(
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number,
): string {
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  // SVG y is flipped vs our math (y-up board)
  const a1 = toRad(startAngle);
  const a2 = toRad(endAngle);

  const x1i = CENTER + innerR * Math.sin(a1);
  const y1i = boardYToSvgY(CENTER + innerR * Math.cos(a1));
  const x2i = CENTER + innerR * Math.sin(a2);
  const y2i = boardYToSvgY(CENTER + innerR * Math.cos(a2));

  const x1o = CENTER + outerR * Math.sin(a1);
  const y1o = boardYToSvgY(CENTER + outerR * Math.cos(a1));
  const x2o = CENTER + outerR * Math.sin(a2);
  const y2o = boardYToSvgY(CENTER + outerR * Math.cos(a2));

  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${x1i} ${y1i}`,
    `L ${x1o} ${y1o}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2o} ${y2o}`,
    `L ${x2i} ${y2i}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x1i} ${y1i}`,
    'Z',
  ].join(' ');
}

export function Dartboard({ darts, maxDarts, onDartClick, disabled }: DartboardProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  const handleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (disabled) return;
    if (darts.length >= maxDarts) return;

    const svg = svgRef.current;
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * BOARD_SIZE;
    const svgY = ((e.clientY - rect.top) / rect.height) * BOARD_SIZE;

    const boardX = Math.round(svgX);
    const boardY = Math.round(BOARD_SIZE - svgY);

    const score = scoreFromBoardCoords(boardX, boardY);

    onDartClick({ x: boardX, y: boardY, score });
  }, [disabled, darts.length, onDartClick]);

  return (
    <div className="relative select-none">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${BOARD_SIZE} ${BOARD_SIZE}`}
        className="w-full max-w-[500px] cursor-crosshair"
        onClick={handleClick}
      >
        {/* Board background — full circle including miss area (225mm outer radius) */}
        <circle cx={CENTER} cy={CENTER} r={RADII.boardOuter} fill="#000" />

        {/* Sectors */}
        {SECTOR_ORDER.map((value, i) => {
          const startAngle = i * 18 - 9;
          const endAngle = (i + 1) * 18 - 9;

          return (
            <g key={value}>
              {/* Single area (between triple and double) */}
              <path
                d={sectorPath(RADII.tripleOuter, RADII.doubleInner, startAngle, endAngle)}
                fill={getSectorColor(i)}
              />
              {/* Inner single (between bull and triple) */}
              <path
                d={sectorPath(RADII.outerBull, RADII.tripleInner, startAngle, endAngle)}
                fill={getSectorColor(i)}
              />
              {/* Triple ring */}
              <path
                d={sectorPath(RADII.tripleInner, RADII.tripleOuter, startAngle, endAngle)}
                fill={getDoubleTripleColor(i)}
              />
              {/* Double ring */}
              <path
                d={sectorPath(RADII.doubleInner, RADII.doubleOuter, startAngle, endAngle)}
                fill={getDoubleTripleColor(i)}
              />
            </g>
          );
        })}

        {/* Bull ring wire (between outer and inner bull, before bull fills) */}
        <circle cx={CENTER} cy={CENTER} r={RADII.innerBull} fill="none" stroke="#333" strokeWidth="500" />

        {/* Bulls */}
        <circle cx={CENTER} cy={CENTER} r={RADII.outerBull} fill="#4a4" />
        <circle cx={CENTER} cy={CENTER} r={RADII.innerBull} fill="#d44" />

        {/* Spider lines (sector dividers) — start from outer bull to avoid painting over bulls */}
        {SECTOR_ORDER.map((_, i) => {
          const angle = (i * 18 - 9) * Math.PI / 180;
          const x = CENTER + RADII.doubleOuter * Math.sin(angle);
          const y = boardYToSvgY(CENTER + RADII.doubleOuter * Math.cos(angle));
          const bx = CENTER + RADII.outerBull * Math.sin(angle);
          const by = boardYToSvgY(CENTER + RADII.outerBull * Math.cos(angle));
          return (
            <line
              key={`wire-${i}`}
              x1={bx}
              y1={by}
              x2={x}
              y2={y}
              stroke="#333"
              strokeWidth="500"
            />
          );
        })}

        {/* Ring wires */}
        {[
          [RADII.doubleInner, 600],
          [RADII.doubleOuter, 800],
          [RADII.tripleInner, 600],
          [RADII.tripleOuter, 600],
          [RADII.outerBull, 500],
        ].map(([r, sw]) => (
          <circle key={`ring-${r}`} cx={CENTER} cy={CENTER} r={r} fill="none" stroke="#333" strokeWidth={sw} />
        ))}

        {/* Sector numbers */}
        {SECTOR_ORDER.map((value, i) => {
          const angle = (i * 18 * Math.PI) / 180; // centered at top of sector
          const labelR = RADII.doubleOuter + 30_000;
          const lx = CENTER + labelR * Math.sin(angle);
          const ly = boardYToSvgY(CENTER + labelR * Math.cos(angle));

          return (
            <text
              key={`label-${value}`}
              x={lx}
              y={ly}
              textAnchor="middle"
              dominantBaseline="central"
              fill="white"
              fontSize="18"
              fontWeight="bold"
              fontFamily="monospace"
            >
              {value}
            </text>
          );
        })}

        {/* Dart markers */}
        {darts.map((dart, i) => (
          <DartMarker key={i} dart={dart} index={i} />
        ))}
      </svg>
    </div>
  );
}
