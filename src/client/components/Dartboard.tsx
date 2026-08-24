import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  RADII, CENTER, MM, SVG_SIZE, WIRE, WIRE_PASSES,
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
import { Box, VisuallyHidden } from '@mantine/core';

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
 * The number ring, in the millimetres a printed board gives it: 26mm of type, centred 200mm out.
 *
 * Both are millimetres and both go through `MM`, which is what keeps the numbers the same share of
 * the board however large it is drawn — the property the single constant these replaced was there
 * to guarantee, now that the size and the radius are no longer the same number. The room they have
 * is between the double ring at 170mm and the drawn edge at 225mm: at this radius a 26mm cap
 * reaches 209mm, so the numbers sit out against the edge with the ring well clear beneath them.
 */
const LABEL_SIZE = 26 * MM;
const LABEL_RADIUS = 200 * MM;

/** The steel rim, set in off the drawn edge so the surround still shows outside it. */
const RIM = { radius: RADII.boardOuter - 2 * MM, width: 4 * MM };

/** Where the sisal stops and the surround begins — a shadowed seam, not a drawn line. */
const SISAL_EDGE = { radius: 175 * MM, width: 6 * MM };

/**
 * How coarse the fibre is, in cycles per SVG unit.
 *
 * Sisal grain is about a millimetre across, and `feTurbulence` counts its frequency in user units
 * rather than in anything physical — so the same board drawn in a different coordinate space needs
 * a different number for the same texture. This is that conversion, and the reason it is written as
 * a division rather than as the 3.83 it comes to.
 */
const GRAIN_FREQUENCY = 0.85 / MM;

/** Every wire that is a circle, at the thickness the real board gives it. */
const RING_WIRES: readonly (readonly [number, number])[] = [
  [RADII.innerBull, WIRE.thin],
  [RADII.outerBull, WIRE.thin],
  [RADII.tripleInner, WIRE.normal],
  [RADII.tripleOuter, WIRE.normal],
  [RADII.doubleInner, WIRE.normal],
  [RADII.doubleOuter, WIRE.thick],
];

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
    // The board area is a size-query container, so `cqmin` is the smaller of the width and height
    // its grid box gives it. The wrapper can therefore remain square without overflowing either.
    //
    // The board is square, while the grid box supplies both the available width and a stable fixed
    // height. The SVG and its video overlay therefore always share the same responsive square.
    <Box
      pos="relative"
      w="100cqmin"
      style={{ aspectRatio: '1', overflow: 'hidden', userSelect: 'none' }}
    >
      <svg
        ref={svgRef}
        data-testid="dartboard"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.size} ${viewBox.size}`}
        style={{
          display: 'block',
          height: '100%',
          width: '100%',
          touchAction: 'none',
          cursor: precisionAim ? 'none' : canPlaceDart ? 'var(--dartboard-active-cursor, crosshair)' : 'not-allowed',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={(event) => cancelGesture(event.pointerId)}
        onLostPointerCapture={(event) => cancelGesture(event.pointerId)}
        onContextMenu={(event) => event.preventDefault()}
      >
        <defs>
          {/* The surround, lit from above: a moulded ring catches the light along its top edge and
              loses it at the bottom. The rim inside it is steel and takes that same light its own
              way — darkest at the crown, brightest out at the sides where the ring turns edge-on,
              dark again at the foot — while staying a step brighter than the plastic behind it at
              every height. Both are objectBoundingBox gradients, so neither of them cares what
              coordinate space the board is drawn in or how far it is zoomed. */}
          <linearGradient id="board-surround" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#232529" />
            <stop offset="0.45" stopColor="#16181b" />
            <stop offset="1" stopColor="#0b0c0f" />
          </linearGradient>
          <linearGradient id="board-rim" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2a2d31" />
            <stop offset="0.5" stopColor="#3c4046" />
            <stop offset="1" stopColor="#191b1f" />
          </linearGradient>

          {/* One soft highlight over the whole board, off-centre up and left. It is what stops the
              board reading as a flat diagram: every bed is the same colour it was, but no two are
              lit the same amount. */}
          <radialGradient id="board-sheen" cx="0.38" cy="0.3" r="0.85">
            <stop offset="0" stopColor="#fff" stopOpacity="0.16" />
            <stop offset="0.45" stopColor="#fff" stopOpacity="0.05" />
            <stop offset="0.8" stopColor="#000" stopOpacity="0.12" />
            <stop offset="1" stopColor="#000" stopOpacity="0.3" />
          </radialGradient>

          {/* Sisal fibre. Noise, desaturated to grey so it darkens and lightens a bed without
              tinting it, flattened to a sixteenth of its opacity, and clipped back to the shape it
              was asked to cover. Two octaves: this is a surface, not a landscape, and the board is
              re-rasterised on every frame of a precision drag. */}
          <filter id="board-grain" x="-2%" y="-2%" width="104%" height="104%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency={GRAIN_FREQUENCY}
              numOctaves={2}
              seed={11}
              stitchTiles="stitch"
            />
            <feColorMatrix type="saturate" values="0" />
            <feComponentTransfer><feFuncA type="linear" slope={0.16} /></feComponentTransfer>
            <feComposite operator="in" in2="SourceGraphic" />
          </filter>
        </defs>

        {/* Board background — full circle including miss area (225mm outer radius) */}
        <circle cx={CENTER} cy={CENTER} r={RADII.boardOuter} fill="url(#board-surround)" />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RIM.radius}
          fill="none"
          stroke="url(#board-rim)"
          strokeWidth={RIM.width}
        />

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

        {/* Bulls. Their wires are not here but down in the spider with the rest: an inner-bull
            wire drawn at this point in the paint order is covered by the outer bull's own disc a
            line later, which is exactly what used to happen to it. */}
        <circle cx={CENTER} cy={CENTER} r={RADII.outerBull} fill="#1e7c3f" />
        <circle cx={CENTER} cy={CENTER} r={RADII.innerBull} fill="#ce2431" />

        {/* The fibre itself, over every bed and under every wire, because that is the order the
            board is made in: the sisal is dyed and then the spider is laid on top of it. */}
        <circle cx={CENTER} cy={CENTER} r={RADII.doubleOuter} fill="#808080" filter="url(#board-grain)" />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={SISAL_EDGE.radius}
          fill="none"
          stroke="#000"
          strokeOpacity={0.3}
          strokeWidth={SISAL_EDGE.width}
        />

        {/* The highlight goes on before the wires and the numbers, so those two stay crisp while
            everything they lie on is shaded. */}
        <circle cx={CENTER} cy={CENTER} r={RADII.boardOuter} fill="url(#board-sheen)" />

        {/* The spider, laid down one whole pass at a time. See WIRE_PASSES. */}
        {WIRE_PASSES.map((pass) => (
          <g key={`wire-pass-${pass.stroke}`} fill="none" stroke={pass.stroke} strokeOpacity={pass.opacity}>
            {/* Sector dividers — start from outer bull to avoid painting over bulls */}
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
                  strokeWidth={WIRE.thin * pass.width}
                />
              );
            })}

            {/* Ring wires */}
            {RING_WIRES.map(([r, sw]) => (
              <circle key={`ring-${r}`} cx={CENTER} cy={CENTER} r={r} strokeWidth={sw * pass.width} />
            ))}
          </g>
        ))}

        {/* Sector numbers */}
        {SECTOR_ORDER.map((value, i) => {
          const angle = (i * 18 * Math.PI) / 180; // centered at top of sector
          const lx = CENTER + LABEL_RADIUS * Math.sin(angle);
          const ly = CENTER - LABEL_RADIUS * Math.cos(angle);

          return (
            <text
              key={`label-${value}`}
              x={lx}
              y={ly}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#f5efdd"
              fontSize={LABEL_SIZE}
              fontWeight={900}
              fontFamily="'Arial Black','Helvetica Neue',Arial,sans-serif"
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
        <VisuallyHidden
          data-testid="precision-status"
          role="status"
        >
          Precision aiming at {precisionThrow.score.label}; release to place
        </VisuallyHidden>
      )}
    </Box>
  );
}
