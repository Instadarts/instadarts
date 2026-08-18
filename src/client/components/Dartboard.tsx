import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  RADII, CENTER, SVG_SIZE, WIRE,
  SECTOR_ORDER,
  getSectorColor, getDoubleTripleColor,
  toBoard,
} from './boardGeometry';
import { DartMarker } from './DartMarker';
import { PrecisionDart } from './PrecisionDart';
import {
  HOLD_TO_AIM_MS,
  NORMAL_VIEW_BOX,
  PRECISION_ZOOM,
  keepOnBoard,
  pointInView,
  precisionTipAt,
  precisionViewBox,
  type BoardViewBox,
  type PrecisionOrigin,
  type SvgPoint,
} from './dartboardPrecision';
import type { DartThrow } from '../../shared/types';
import { scoreFromBoardCoords } from '../../shared/scoring';

interface DartboardProps {
  darts: DartThrow[];
  /** How many darts the visit may hold. The game mode decides. */
  maxDarts: number;
  onDartClick: (dart: DartThrow) => void;
  disabled?: boolean;
  /** An optional live picture layered over the virtual board without unmounting the fallback. */
  children?: ReactNode;
}

/**
 * How tall a sector number is, in SVG units — so about 4% of the board's width, whatever the board
 * is currently being drawn at. It doubles as the distance the numbers sit outside the double ring,
 * which is what keeps them clear of it at every size.
 */
const LABEL_SIZE = 4;

interface PrecisionAim {
  tip: SvgPoint;
  viewBox: BoardViewBox;
}

interface PointerGesture {
  pointerId: number;
  latestClientX: number;
  latestClientY: number;
  holdTimer: number | null;
  precision: boolean;
  viewBox?: BoardViewBox;
  precisionOrigin?: PrecisionOrigin;
}

function throwAt(point: SvgPoint): DartThrow {
  const { x, y } = toBoard(point);
  return { x, y, score: scoreFromBoardCoords(x, y) };
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
  const y1i = CENTER - innerR * Math.cos(a1);
  const x2i = CENTER + innerR * Math.sin(a2);
  const y2i = CENTER - innerR * Math.cos(a2);

  const x1o = CENTER + outerR * Math.sin(a1);
  const y1o = CENTER - outerR * Math.cos(a1);
  const x2o = CENTER + outerR * Math.sin(a2);
  const y2o = CENTER - outerR * Math.cos(a2);

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

export function Dartboard({ darts, maxDarts, onDartClick, disabled, children }: DartboardProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gestureRef = useRef<PointerGesture | null>(null);
  const [precisionAim, setPrecisionAim] = useState<PrecisionAim | null>(null);
  const canPlaceDart = !disabled && darts.length < maxDarts;

  const cancelGesture = useCallback((pointerId?: number) => {
    const gesture = gestureRef.current;
    if (!gesture || (pointerId !== undefined && gesture.pointerId !== pointerId)) return;

    if (gesture.holdTimer !== null) window.clearTimeout(gesture.holdTimer);
    gestureRef.current = null;
    setPrecisionAim(null);

    const svg = svgRef.current;
    if (svg?.hasPointerCapture(gesture.pointerId)) svg.releasePointerCapture(gesture.pointerId);
  }, []);

  useEffect(() => () => {
    const timer = gestureRef.current?.holdTimer;
    if (timer !== null && timer !== undefined) window.clearTimeout(timer);
  }, []);

  // A turn can be locked remotely while a finger is still down. Never let that stale gesture land.
  useEffect(() => {
    if (!canPlaceDart) cancelGesture();
  }, [cancelGesture, canPlaceDart]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (!canPlaceDart || !event.isPrimary || event.button !== 0 || gestureRef.current) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const gesture: PointerGesture = {
      pointerId: event.pointerId,
      latestClientX: event.clientX,
      latestClientY: event.clientY,
      holdTimer: null,
      precision: false,
    };

    gesture.holdTimer = window.setTimeout(() => {
      const active = gestureRef.current;
      const svg = svgRef.current;
      if (!active || active !== gesture || !svg) return;

      const rect = svg.getBoundingClientRect();
      const tip = keepOnBoard(pointInView(
        active.latestClientX,
        active.latestClientY,
        rect,
        NORMAL_VIEW_BOX,
      ));
      const size = SVG_SIZE / PRECISION_ZOOM;
      const viewBox = precisionViewBox(
        tip,
        size,
        active.latestClientX,
        active.latestClientY,
        rect,
      );

      active.holdTimer = null;
      active.precision = true;
      active.viewBox = viewBox;
      active.precisionOrigin = {
        clientX: active.latestClientX,
        clientY: active.latestClientY,
        tip,
      };
      setPrecisionAim({ tip, viewBox });
    }, HOLD_TO_AIM_MS);

    gestureRef.current = gesture;
  }, [canPlaceDart]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    gesture.latestClientX = event.clientX;
    gesture.latestClientY = event.clientY;
    if (!gesture.precision || !gesture.viewBox || !gesture.precisionOrigin) return;

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const tip = precisionTipAt(
      event.clientX,
      event.clientY,
      rect,
      gesture.viewBox,
      gesture.precisionOrigin,
    );
    setPrecisionAim({ viewBox: gesture.viewBox, tip });
  }, []);

  const handlePointerUp = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    event.preventDefault();
    if (!canPlaceDart) {
      cancelGesture(event.pointerId);
      return;
    }
    if (gesture.holdTimer !== null) window.clearTimeout(gesture.holdTimer);

    const rect = event.currentTarget.getBoundingClientRect();
    const point = gesture.precision && gesture.viewBox && gesture.precisionOrigin
      ? precisionTipAt(
          event.clientX,
          event.clientY,
          rect,
          gesture.viewBox,
          gesture.precisionOrigin,
        )
      : keepOnBoard(pointInView(event.clientX, event.clientY, rect, NORMAL_VIEW_BOX));

    // Clear first: adding the dart changes props immediately in a local match and must not leave a
    // captured pointer or the enlarged board behind during that render.
    gestureRef.current = null;
    setPrecisionAim(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onDartClick(throwAt(point));
  }, [cancelGesture, canPlaceDart, onDartClick]);

  const precisionThrow = precisionAim ? throwAt(precisionAim.tip) : null;
  const viewBox = precisionAim?.viewBox ?? NORMAL_VIEW_BOX;

  return (
    // The size cap lives on the wrapper rather than the svg, so the board is as wide as it is
    // allowed to be wherever it is put. On the svg alone it would have nothing to be a percentage
    // of — the column that holds it centres its children, and a centred child is only as wide as
    // its contents, which for an svg means whatever the viewBox happens to imply.
    //
    // The board is square, so its width is also its height, and it has to be capped by both. It
    // takes the full width it is offered, up to the height of the box it sits in — `100cqh`, which
    // resolves against the nearest size container. On the match screen that box is exactly the
    // space left over once everything else has been laid out, so the board grows until it fills
    // the window vertically and then stops. With no size container above it, `cqh` falls back to
    // the viewport, which is the right answer anywhere else. `self-center` is equally important:
    // the match's flex row is deliberately taller than the board when it reserves room for visit
    // controls, and the default cross-axis stretch would otherwise make this wrapper rectangular.
    // The SVG keeps its own ratio in that rectangle, but an absolutely positioned video fills it.
    <div className="relative aspect-square self-center select-none w-full max-w-[600px] overflow-hidden lg:max-w-[100cqh]">
      <svg
        ref={svgRef}
        data-testid="dartboard"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.size} ${viewBox.size}`}
        className={`block h-full w-full touch-none ${precisionAim ? 'cursor-none' : canPlaceDart ? 'cursor-crosshair' : 'cursor-not-allowed'}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={(event) => cancelGesture(event.pointerId)}
        onLostPointerCapture={(event) => cancelGesture(event.pointerId)}
        onContextMenu={(event) => event.preventDefault()}
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
        <circle cx={CENTER} cy={CENTER} r={RADII.innerBull} fill="none" stroke="#333" strokeWidth={WIRE.thin} />

        {/* Bulls */}
        <circle cx={CENTER} cy={CENTER} r={RADII.outerBull} fill="#4a4" />
        <circle cx={CENTER} cy={CENTER} r={RADII.innerBull} fill="#d44" />

        {/* Spider lines (sector dividers) — start from outer bull to avoid painting over bulls */}
        {SECTOR_ORDER.map((_, i) => {
          const angle = (i * 18 - 9) * Math.PI / 180;
          const x = CENTER + RADII.doubleOuter * Math.sin(angle);
          const y = CENTER - RADII.doubleOuter * Math.cos(angle);
          const bx = CENTER + RADII.outerBull * Math.sin(angle);
          const by = CENTER - RADII.outerBull * Math.cos(angle);
          return (
            <line
              key={`wire-${i}`}
              x1={bx}
              y1={by}
              x2={x}
              y2={y}
              stroke="#333"
              strokeWidth={WIRE.thin}
            />
          );
        })}

        {/* Ring wires */}
        {[
          [RADII.doubleInner, WIRE.normal],
          [RADII.doubleOuter, WIRE.thick],
          [RADII.tripleInner, WIRE.normal],
          [RADII.tripleOuter, WIRE.normal],
          [RADII.outerBull, WIRE.thin],
        ].map(([r, sw]) => (
          <circle key={`ring-${r}`} cx={CENTER} cy={CENTER} r={r} fill="none" stroke="#333" strokeWidth={sw} />
        ))}

        {/* Sector numbers */}
        {SECTOR_ORDER.map((value, i) => {
          const angle = (i * 18 * Math.PI) / 180; // centered at top of sector
          // Between the double ring and the edge of the board, where the numbers are printed.
          const labelR = RADII.doubleOuter + LABEL_SIZE;
          const lx = CENTER + labelR * Math.sin(angle);
          const ly = CENTER - labelR * Math.cos(angle);

          return (
            <text
              key={`label-${value}`}
              x={lx}
              y={ly}
              textAnchor="middle"
              dominantBaseline="central"
              fill="white"
              fontSize={LABEL_SIZE}
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

        {/* During a hold this replaces the fingertip-obscured dot. Its needle starts at the exact
            coordinate that will be scored, while its rear projects up-left toward the finger. */}
        {precisionAim && precisionThrow && (
          <PrecisionDart
            tip={precisionAim.tip}
            viewportSize={precisionAim.viewBox.size}
            dart={precisionThrow}
          />
        )}
      </svg>
      {children}
      {precisionThrow && (
        <div
          data-testid="precision-status"
          role="status"
          className="sr-only"
        >
          Precision aiming at {precisionThrow.score.label}; release to place
        </div>
      )}
    </div>
  );
}
