import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModePanelProps } from './panels';
import { RADII, CENTER, SECTOR_ORDER } from '../components/boardGeometry';

// Whac-A-Mole's second file.
//
// The mode's rules live on the server and none of them live here: everything below is drawn from the
// snapshot `panel.custom` carries, and this file decides only what that looks like.
//
// It draws three surfaces rather than the usual one:
//
//   1. **The board.** A component in the panel slot has no way to take a dart — `ModePanelProps` is
//      the panel and nothing else — so the real dartboard stays the input surface and this overlays
//      it: an absolutely positioned svg portalled into the board's own wrapper, mirroring its
//      viewBox so it follows the precision-aim zoom, and `pointer-events: none` so every click still
//      lands on the board underneath. The one exception is the shield, which is there precisely to
//      stop a player throwing when they have nothing left to throw.
//   2. **The panel slot**, which holds the score, the round and what is currently digging.
//   3. **A finale**, filling that same board square, on the visit that ends the run. It has to be
//      there rather than on the match summary, because the summary does not render a mode's panel
//      at all — and it stays inside the board so that the Submit button it asks you to press, and
//      the scores it is reporting on, are still in front of you.
//
// If the board is not on screen — a layout change, a future refactor — the overlay simply does not
// mount and the rest keeps working.

// ============================================================
// What the server sends
// ============================================================

interface MoleView {
  id: number;
  area: string;
  label: string;
  age: number;
  digTime: number;
  enraged: boolean;
  variant: number;
  reaction?: { kind: string; text: string };
}

interface EventView {
  kind: 'spawn' | 'whack' | 'perfect' | 'near' | 'hole' | 'escape' | 'rescue';
  area: string;
  label: string;
  call: string;
  dart?: number;
  moleId?: number;
  playerId?: string;
  ownerId?: string;
}

/** Up for one visit, holding the oldest dart in the burrow. Null when it is not in. */
interface JanitorView {
  ownerId: string;
  ownerName: string;
  /** How many darts are down there in total, this one included. */
  queue: number;
  grumble: string;
}

interface PlayerView {
  id: string;
  name: string;
  score: number;
  allowance: number;
  darts: number;
  out: boolean;
  isCurrent: boolean;
  /** Darts handed back this visit. They return to the allowance next visit, like a loss does. */
  returning: number;
}

interface RunView {
  phase: 'playing' | 'pass' | 'finale';
  round: number;
  rounds: number;
  stage: 'calm' | 'enraged' | 'frenzy';
  moleCount: number;
  banner?: 'enraged' | 'frenzy';
  team: number;
  players: PlayerView[];
  moles: MoleView[];
  holes: { area: string; label: string }[];
  /** The area id of the middle of the board — a hole from the first dart. */
  burrow: string;
  janitor: JanitorView | null;
  lost: number;
  events: EventView[];
  buried: string[];
  stats: { whacked: number; escaped: number; perfectVisits: number; holes: number; rescued: number };
}

export default function WhacAMolePanel({ panel }: ModePanelProps) {
  // Before the early return: the board is looked up once for everything that draws on it.
  const { host, svg } = useBoard();
  const run = panel.custom as RunView | undefined;
  if (!run || !Array.isArray(run.players)) return null;

  return (
    <>
      <Styles />
      {host && <BoardOverlay run={run} host={host} svg={svg} />}
      <Hud run={run} />
      {host && run.phase === 'finale' && <Finale run={run} host={host} />}
    </>
  );
}

// ============================================================
// Finding the board
// ============================================================

/**
 * The live dartboard, and the box it is drawn in.
 *
 * Looked up rather than passed, because nothing passes it: the observer is what notices the board
 * arriving, leaving, or being replaced when the match screen re-lays itself out.
 */
function useBoard(): { host: HTMLElement | null; svg: SVGSVGElement | null } {
  const [found, setFound] = useState<{ host: HTMLElement | null; svg: SVGSVGElement | null }>({
    host: null,
    svg: null,
  });

  useEffect(() => {
    const look = () => {
      const svg = document.querySelector<SVGSVGElement>('[data-testid="dartboard"]');
      const host = (svg?.parentElement as HTMLElement | null) ?? null;
      setFound((prev) => (prev.svg === svg && prev.host === host ? prev : { host, svg: svg ?? null }));
    };

    look();
    const observer = new MutationObserver(look);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return found;
}

/**
 * The board's viewBox, as it currently is.
 *
 * Press-and-hold on the board zooms it to aim, which rewrites this attribute many times a second.
 * Mirroring it is what keeps a mole glued to its own segment while that happens, instead of the
 * overlay sitting still over a board that has moved under it.
 */
function useViewBox(svg: SVGSVGElement | null): string {
  const [box, setBox] = useState('0 0 100 100');

  useEffect(() => {
    if (!svg) return;
    const read = () => setBox(svg.getAttribute('viewBox') || '0 0 100 100');
    read();
    const observer = new MutationObserver(read);
    observer.observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
    return () => observer.disconnect();
  }, [svg]);

  return box;
}

// ============================================================
// Board geometry
// ============================================================

/** The board is drawn across 100 units, so everything here is a few of them. See boardGeometry.ts. */
const MOLE_SIZE = 1.05;

/** An outer single, in square units. What a mole drawn at full size is sized against. */
const BIGGEST_AREA = 110;

function ringPath(innerR: number, outerR: number, startAngle: number, endAngle: number): string {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const at = (r: number, a: number) => `${CENTER + r * Math.sin(rad(a))} ${CENTER - r * Math.cos(rad(a))}`;

  return [
    `M ${at(innerR, startAngle)}`,
    `L ${at(outerR, startAngle)}`,
    `A ${outerR} ${outerR} 0 0 1 ${at(outerR, endAngle)}`,
    `L ${at(innerR, endAngle)}`,
    `A ${innerR} ${innerR} 0 0 0 ${at(innerR, startAngle)}`,
    'Z',
  ].join(' ');
}

function discPath(r: number): string {
  return `M ${CENTER - r} ${CENTER} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
}

/**
 * An area id — `S20o`, `S20i`, `T20`, `D20`, `BULL` — as radii and an angle.
 *
 * `BULL` is both bulls at once: this mode makes no distinction, because the middle of the board is
 * not a target here but the burrow every mole came out of.
 */
function bandOf(area: string): { inner: number; outer: number; sector: number | null } | null {
  if (area === 'BULL') return { inner: 0, outer: RADII.outerBull, sector: null };

  const ring = area[0];
  const number = ring === 'S' ? Number(area.slice(1, -1)) : Number(area.slice(1));
  const sector = SECTOR_ORDER.indexOf(number);
  if (sector < 0) return null;

  if (ring === 'T') return { inner: RADII.tripleInner, outer: RADII.tripleOuter, sector };
  if (ring === 'D') return { inner: RADII.doubleInner, outer: RADII.doubleOuter, sector };
  if (area.endsWith('i')) return { inner: RADII.outerBull, outer: RADII.tripleInner, sector };
  return { inner: RADII.tripleOuter, outer: RADII.doubleInner, sector };
}

/** The outline of an area, for tinting it or filling it in as a hole. */
function areaPath(area: string): string {
  const band = bandOf(area);
  if (!band) return '';
  if (band.sector === null) {
    return band.inner === 0
      ? discPath(band.outer)
      : `${discPath(band.outer)} ${discPath(band.inner)}`;
  }
  return ringPath(band.inner, band.outer, band.sector * 18 - 9, band.sector * 18 + 9);
}

/** The middle of an area, which is where whatever is standing on it stands. */
function areaCentre(area: string): { x: number; y: number } {
  const band = bandOf(area);
  if (!band) return { x: CENTER, y: CENTER };
  if (band.sector === null) return { x: CENTER, y: CENTER };

  const r = (band.inner + band.outer) / 2;
  const a = (band.sector * 18 * Math.PI) / 180;
  return { x: CENTER + r * Math.sin(a), y: CENTER - r * Math.cos(a) };
}

/**
 * How big the mole on an area is drawn.
 *
 * As big as what it is digging, down to a floor: a treble is a fiftieth of an outer single and a
 * mole scaled honestly into one would be a speck. It reads as difficulty — a small mole is a small
 * target — and it is what keeps three moles in neighbouring rings from piling on top of each other.
 */
function moleScaleFor(area: string): number {
  const band = bandOf(area);
  if (!band) return MOLE_SIZE;

  const ring = Math.PI * (band.outer ** 2 - band.inner ** 2);
  const size = band.sector === null ? ring : ring / 20;
  return Math.min(MOLE_SIZE, Math.max(0.62, MOLE_SIZE * Math.sqrt(size / BIGGEST_AREA)));
}

/**
 * Where a mole's speech bubble goes: outwards from the middle of the board, so it never covers the
 * area the player is about to aim at, and never leaves the board.
 */
function bubbleAnchor(area: string): { x: number; y: number; flip: boolean } {
  const { x, y } = areaCentre(area);
  const left = x > CENTER;
  return { x: x + (left ? -10.5 : 10.5), y: Math.max(9, y - 8.5), flip: left };
}

// ============================================================
// The board overlay
// ============================================================

function BoardOverlay({ run, host, svg }: { run: RunView; host: HTMLElement; svg: SVGSVGElement | null }) {
  const viewBox = useViewBox(svg);
  const precision = usePrecisionMirror(svg);

  const whacks = run.events.filter((e) => e.kind === 'whack');
  const rescues = run.events.filter((e) => e.kind === 'rescue');
  const holeHits = run.events.filter((e) => e.kind === 'hole' && e.area !== run.burrow);
  const burrowHits = run.events.filter((e) => e.kind === 'hole' && e.area === run.burrow);
  const fresh = new Set(run.events.filter((e) => e.kind === 'spawn').map((e) => e.area));
  const buried = new Set(run.buried);
  const blocked = run.phase === 'pass';

  return createPortal(
    <svg
      viewBox={viewBox}
      className="absolute inset-0 h-full w-full z-30"
      style={{ pointerEvents: 'none' }}
      aria-hidden
    >
      <defs>
        <radialGradient id="wam-hole" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor="#000000" />
          <stop offset="55%" stopColor="#1c1008" />
          <stop offset="100%" stopColor="#4a2f19" />
        </radialGradient>
      </defs>

      {/* Every area a mole dug through, the burrow in the middle included — that one was there
          before anybody threw. `data-hole` and the `data-area` on the roster chips are how a test
          says "click the thing this mode has put there"; the board has no per-segment elements. */}
      {run.holes.map((hole) => (
        <g key={`hole-${hole.area}`} data-hole={hole.area} className={buried.has(hole.area) ? 'wam-dug' : undefined}>
          <path d={areaPath(hole.area)} fill="url(#wam-hole)" fillRule="evenodd" />
          <path
            d={areaPath(hole.area)}
            fill="none"
            fillRule="evenodd"
            stroke={hole.area === run.burrow ? '#8a5a30' : '#7a5230'}
            strokeWidth={hole.area === run.burrow ? 0.5 : 0.3}
            strokeDasharray="0.8 0.5"
            opacity={0.9}
          />
        </g>
      ))}

      {/* Two passes over the same moles, and the order is the point: every target's outline is laid
          down before any mole is drawn, so no mole is ever cut in half by its neighbour's border. */}
      {run.moles.map((mole) => (
        <TargetRing key={`ring-${mole.id}`} mole={mole} />
      ))}
      {run.moles.map((mole) => (
        <TargetMole key={`mole-${mole.id}`} mole={mole} fresh={fresh.has(mole.area)} />
      ))}

      {/* The janitor, over everything on the board: it is this visit's biggest thing to hit. */}
      {run.janitor && <Janitor janitor={run.janitor} area={run.burrow} />}

      {/* What happened this visit, kept on screen until the visit is submitted. */}
      {whacks.map((event) => (
        <Whack key={`whack-${event.moleId}`} event={event} />
      ))}
      {rescues.map((event) => (
        <Whack key={`rescue-${event.dart}`} event={event} />
      ))}
      {holeHits.map((event) => (
        <HoleTaunt key={`holehit-${event.dart}-${event.area}`} event={event} />
      ))}
      {burrowHits.map((event) => (
        <HoleTaunt key={`burrow-${event.dart}`} event={event} />
      ))}

      {run.banner && <Banner stage={run.banner} />}

      {/* Nothing left to throw. A shield rather than a message alone, because at the start of a
          visit there is no locked visit for the board itself to know about. The finale needs none:
          the closing screen fills the board and takes the clicks itself. */}
      {blocked && (
        <g style={{ pointerEvents: 'auto' }}>
          <rect x={0} y={0} width={100} height={100} fill="#05070c" opacity={0.72} />
          <text x={50} y={47} textAnchor="middle" fill="#fbbf24" fontSize={6} fontWeight="bold" fontFamily="monospace">
            OUT OF DARTS
          </text>
          <text x={50} y={54} textAnchor="middle" fill="#94a3b8" fontSize={3} fontFamily="monospace">
            Submit Visit to pass
          </text>
        </g>
      )}

      {/* Last of all: see `usePrecisionMirror`. */}
      <g ref={precision} />
    </svg>,
    host,
  );
}

/**
 * The aiming dart, copied out of the board and drawn again on top of everything here.
 *
 * The board draws it as the last thing inside its own svg, and this overlay is a sibling painted
 * above that svg — so without this, a mole would cover the dart the player is lining up, which is
 * the one thing on screen that must never be covered. Copying it is the only way round that: the
 * overlay cannot go *under* the board, because the board paints an opaque circle.
 *
 * Both svgs carry the same viewBox, so the copy lands exactly on the original.
 */
function usePrecisionMirror(svg: SVGSVGElement | null) {
  const ref = useRef<SVGGElement>(null);

  useEffect(() => {
    if (!svg) return;

    const sync = () => {
      const host = ref.current;
      if (!host) return;
      const dart = svg.querySelector('[data-testid="precision-dart"]');
      // Cloning into our own svg does not disturb the one being observed, so this cannot loop.
      if (dart) host.replaceChildren(dart.cloneNode(true));
      else if (host.firstChild) host.replaceChildren();
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(svg, { childList: true, subtree: true, attributes: true });
    return () => observer.disconnect();
  }, [svg]);

  return ref;
}

/** How urgent a mole is, which decides its colour and how fast its target pulses. */
function tintFor(mole: MoleView): { tint: string; left: number; urgent: boolean } {
  const left = Math.max(0, mole.digTime - mole.age);
  const urgent = left <= 1;
  return { left, urgent, tint: urgent ? '#ef4444' : left === 2 ? '#f97316' : '#fbbf24' };
}

/**
 * The lit-up area: what is actually being aimed at.
 *
 * It has to read against a cream sector and a black one alike — a tinted fill that breathes, a dark
 * line to sit it on, and a marching outline. Note that the pulse is a CSS animation on `opacity`,
 * which overrides the attribute rather than scaling it, so how urgent this is lives in the colour
 * and the speed, not in a number.
 */
function TargetRing({ mole }: { mole: MoleView }) {
  const { tint, urgent } = tintFor(mole);
  const path = areaPath(mole.area);

  return (
    <g>
      <path d={path} fill={tint} fillRule="evenodd" className={urgent ? 'wam-glow-hot' : 'wam-glow'} />
      <path d={path} fill="none" fillRule="evenodd" stroke="#0b0f16" strokeWidth={1.3} opacity={0.75} />
      <path
        d={path}
        fill="none"
        fillRule="evenodd"
        stroke={tint}
        strokeWidth={0.75}
        strokeDasharray="2.2 1.4"
        className="wam-edge"
      />
    </g>
  );
}

/** The mole standing on it, with however long it has left showing underneath. */
function TargetMole({ mole, fresh }: { mole: MoleView; fresh: boolean }) {
  const { tint, left } = tintFor(mole);
  const scale = moleScaleFor(mole.area);
  const centre = areaCentre(mole.area);

  return (
    <g className={fresh ? 'wam-rise' : undefined} style={{ transformOrigin: `${centre.x}px ${centre.y}px` }}>
      <Mole mole={mole} x={centre.x} y={centre.y} scale={scale} />
      <DigMeter x={centre.x} y={centre.y + 5.4 * scale + 1} digTime={mole.digTime} left={left} colour={tint} />
      {mole.reaction && <Bubble area={mole.area} text={mole.reaction.text} tone="#fde68a" />}
    </g>
  );
}

/**
 * The janitor, up out of the burrow with somebody's dart and no intention of handing it over.
 *
 * Drawn at a size the middle of the board cannot justify — the bull is a millimetre and a half of
 * it — because this is the only way a lost dart ever comes back, and missing it because it was too
 * small to notice would be the worst way to lose a run.
 */
function Janitor({ janitor, area }: { janitor: JanitorView; area: string }) {
  const { x, y } = areaCentre(area);

  // No target ring of any kind. A mole standing in the middle of the board is standing in the bull,
  // and that is not a thing a player has to be told — the other moles are marked because their areas
  // are one of eighty and could be any of them, which is not a question anybody has about this one.
  return (
    <g className="wam-rise" style={{ transformOrigin: `${x}px ${y}px` }}>
      <g transform={`translate(${x} ${y}) scale(0.95)`}>
        <g className="wam-bob">
          <ellipse cx={0} cy={3.5} rx={5.6} ry={2} fill="#4a2f19" />
          <ellipse cx={0} cy={3.2} rx={4.3} ry={1.4} fill="#22150b" />

          <circle cx={-2.7} cy={-2.4} r={0.95} fill="#5a3d2b" />
          <circle cx={2.7} cy={-2.4} r={0.95} fill="#5a3d2b" />
          <ellipse cx={0} cy={0} rx={3.5} ry={3.3} fill="#6f4c36" />
          <ellipse cx={0} cy={-0.5} rx={2.6} ry={2.1} fill="#7d5840" opacity={0.5} />

          {/* A dart held across the chest, which is the whole argument. */}
          <g transform="rotate(-24)">
            <rect x={-4.4} y={1.6} width={7.4} height={0.55} rx={0.27} fill="#e2e8f0" />
            <rect x={-1.2} y={1.35} width={2.6} height={1.05} rx={0.4} fill="#94a3b8" />
            <path d="M 3.0 1.35 l 2.1 0.52 l -2.1 0.52 Z" fill="#f97316" />
            <circle cx={-4.5} cy={1.88} r={0.42} fill="#cbd5e1" />
          </g>
          <ellipse cx={-3.4} cy={2.0} rx={1.15} ry={0.72} fill="#d9b08c" transform="rotate(-24 -3.4 2)" />
          <ellipse cx={2.9} cy={0.6} rx={1.15} ry={0.72} fill="#d9b08c" transform="rotate(-24 2.9 .6)" />

          {/* Cross. Very cross. */}
          <ellipse cx={0} cy={1.15} rx={1.9} ry={1.3} fill="#e0bb98" />
          <ellipse cx={0} cy={0.6} rx={0.6} ry={0.48} fill="#3a2418" />
          <ellipse cx={-1.25} cy={-0.8} rx={0.72} ry={0.72} fill="#f8fafc" />
          <ellipse cx={1.25} cy={-0.8} rx={0.72} ry={0.72} fill="#f8fafc" />
          <circle cx={-1.15} cy={-0.7} r={0.34} fill="#b91c1c" />
          <circle cx={1.35} cy={-0.7} r={0.34} fill="#b91c1c" />
          <g stroke="#3a2418" strokeWidth={0.36} strokeLinecap="round">
            <path d="M -2.35 -2.1 L -0.45 -1.25" />
            <path d="M 2.35 -2.1 L 0.45 -1.25" />
          </g>

          {/* A flat cap, so it is plainly not one of the others. */}
          <path d="M -3.2 -2.3 a 3.2 3.2 0 0 1 6.4 0 Z" fill="#1e3a5f" />
          <path d="M -3.6 -2.25 q 3.6 -0.9 7.2 0 l 0 0.62 q -3.6 -0.9 -7.2 0 Z" fill="#152b47" />

          {janitor.queue > 1 && (
            <g transform="translate(4.2 -3.4)">
              <circle r={1.5} fill="#0f172a" stroke="#67e8f9" strokeWidth={0.22} />
              <text textAnchor="middle" y={0.7} fill="#67e8f9" fontSize={2} fontFamily="monospace">
                {janitor.queue}
              </text>
            </g>
          )}
        </g>
      </g>

      <Bubble area={area} text={janitor.grumble} tone="#a5f3fc" />
    </g>
  );
}

/** How many visits this one has left, as pips. One pip left is its last. */
function DigMeter({ x, y, digTime, left, colour }: {
  x: number; y: number; digTime: number; left: number; colour: string;
}) {
  const width = 1.9;
  const gap = 0.5;
  const total = digTime * width + (digTime - 1) * gap;

  return (
    <g className={left <= 1 ? 'wam-flash' : undefined}>
      {Array.from({ length: digTime }).map((_, i) => (
        <rect
          key={i}
          x={x - total / 2 + i * (width + gap)}
          y={y}
          width={width}
          height={1.1}
          rx={0.55}
          fill={i < left ? colour : '#1f2937'}
          stroke="#0b0f16"
          strokeWidth={0.12}
        />
      ))}
    </g>
  );
}

/**
 * The mole itself.
 *
 * Drawn at a size that stays readable rather than one that fits its area — the bull is a millimetre
 * of board and a mole scaled into it would be a smudge. The lit area underneath is what says exactly
 * where to throw; the mole is who is standing there.
 */
function Mole({ mole, x, y, scale }: { mole: MoleView; x: number; y: number; scale: number }) {
  const face = expressionOf(mole);
  const duck = face === 'duck';

  return (
    // Two elements, deliberately. A CSS transform overrides the `transform` attribute rather than
    // composing with it, so a mole that both sits somewhere and bobs needs one element for each —
    // put them together and every mole animates itself back to the middle of the board.
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <g className="wam-bob">
      {/* Thrown-up earth, so it reads as coming out of the board rather than sitting on it. */}
      <ellipse cx={0} cy={3.5} rx={5.4} ry={1.9} fill="#4a2f19" opacity={0.95} />
      <ellipse cx={0} cy={3.2} rx={4.1} ry={1.3} fill="#22150b" />

      <g transform={duck ? 'translate(0 1.6)' : undefined}>
        {/* Ears and head */}
        <circle cx={-2.7} cy={-2.4} r={0.95} fill="#6b4a34" />
        <circle cx={2.7} cy={-2.4} r={0.95} fill="#6b4a34" />
        <ellipse cx={0} cy={0} rx={3.5} ry={3.3} fill={mole.enraged ? '#8d5a44' : '#8a6246'} />
        <ellipse cx={0} cy={-0.5} rx={2.6} ry={2.1} fill="#9c7355" opacity={0.55} />

        {/* Paws over the rim */}
        <ellipse cx={-3.1} cy={2.5} rx={1.15} ry={0.72} fill="#d9b08c" />
        <ellipse cx={3.1} cy={2.5} rx={1.15} ry={0.72} fill="#d9b08c" />

        {/* Snout */}
        <ellipse cx={0} cy={1.15} rx={1.95} ry={1.35} fill="#e0bb98" />
        <ellipse cx={0} cy={0.55} rx={0.62} ry={0.5} fill="#3a2418" />
        <path d="M -1.95 1.5 L -4.4 1.0 M -1.95 1.9 L -4.3 2.1" stroke="#2b1a10" strokeWidth={0.16} opacity={0.8} />
        <path d="M 1.95 1.5 L 4.4 1.0 M 1.95 1.9 L 4.3 2.1" stroke="#2b1a10" strokeWidth={0.16} opacity={0.8} />

        <Face face={face} enraged={mole.enraged} />
        <Hat variant={mole.variant} />
      </g>

      {mole.enraged && (
        <g className="wam-steam" opacity={0.85}>
          <circle cx={-3.6} cy={-3.4} r={0.6} fill="#fca5a5" />
          <circle cx={-4.5} cy={-4.4} r={0.42} fill="#fca5a5" opacity={0.7} />
          <circle cx={3.6} cy={-3.4} r={0.6} fill="#fca5a5" />
          <circle cx={4.5} cy={-4.4} r={0.42} fill="#fca5a5" opacity={0.7} />
        </g>
      )}
      </g>
    </g>
  );
}

type Expression = 'idle' | 'angry' | 'duck' | 'taunt' | 'laugh' | 'sweat' | 'peek';

function expressionOf(mole: MoleView): Expression {
  const kind = mole.reaction?.kind;
  if (kind === 'duck' || kind === 'taunt' || kind === 'laugh' || kind === 'sweat' || kind === 'peek') return kind;
  return mole.enraged ? 'angry' : 'idle';
}

function Face({ face, enraged }: { face: Expression; enraged: boolean }) {
  const white = '#f8fafc';
  const pupil = enraged ? '#dc2626' : '#1b1109';

  if (face === 'laugh' || face === 'duck') {
    return (
      <g stroke={pupil} strokeWidth={0.26} fill="none" strokeLinecap="round">
        <path d="M -1.9 -0.9 q 0.62 -0.68 1.24 0" />
        <path d="M 0.66 -0.9 q 0.62 -0.68 1.24 0" />
      </g>
    );
  }

  const wide = face === 'peek' || face === 'sweat';
  return (
    <g>
      <ellipse cx={-1.25} cy={-0.75} rx={wide ? 0.78 : 0.66} ry={wide ? 0.82 : 0.66} fill={white} />
      <ellipse cx={1.25} cy={-0.75} rx={wide ? 0.78 : 0.66} ry={wide ? 0.82 : 0.66} fill={white} />
      <circle cx={-1.18} cy={-0.68} r={0.33} fill={pupil} />
      <circle cx={1.32} cy={-0.68} r={0.33} fill={pupil} />

      {(face === 'angry' || face === 'taunt') && (
        <g stroke={enraged ? '#b91c1c' : '#3a2418'} strokeWidth={0.32} strokeLinecap="round">
          <path d="M -2.2 -1.9 L -0.5 -1.3" />
          <path d="M 2.2 -1.9 L 0.5 -1.3" />
        </g>
      )}
      {face === 'taunt' && <ellipse cx={0} cy={2.15} rx={0.7} ry={0.9} fill="#f472b6" />}
      {face === 'sweat' && (
        <path d="M 3.0 -1.6 q 0.75 1.1 0 1.6 q -0.75 -0.5 0 -1.6 Z" fill="#7dd3fc" />
      )}
    </g>
  );
}

/** Three of them, so a board with three moles on it is not three copies of one drawing. */
function Hat({ variant }: { variant: number }) {
  if (variant === 1) {
    return (
      <g>
        <path d="M -2.8 -2.5 a 2.8 2.8 0 0 1 5.6 0 Z" fill="#facc15" />
        <rect x={-3.3} y={-2.65} width={6.6} height={0.6} rx={0.3} fill="#eab308" />
      </g>
    );
  }
  if (variant === 2) {
    return (
      <g>
        <path d="M -3.3 -1.6 q 3.3 -1.2 6.6 0 l 0 -0.9 q -3.3 -1.2 -6.6 0 Z" fill="#ef4444" />
        <path d="M 3.1 -1.9 l 1.7 0.7 l -1.5 0.8 Z" fill="#dc2626" />
      </g>
    );
  }
  return null;
}

/** A dart that landed on a mole. Stays put for the rest of the visit, so the visit reads back. */
function Whack({ event }: { event: EventView }) {
  const { x, y } = areaCentre(event.area);
  const spikes = Array.from({ length: 12 }).map((_, i) => {
    const a = (i * 30 * Math.PI) / 180;
    const r = i % 2 === 0 ? 6.2 : 3.5;
    return `${x + r * Math.cos(a)} ${y + r * Math.sin(a)}`;
  });

  return (
    <g className="wam-bonk" style={{ transformOrigin: `${x}px ${y}px` }}>
      <polygon points={spikes.join(' ')} fill="#fde047" stroke="#b45309" strokeWidth={0.35} />
      <text x={x} y={y + 1.2} textAnchor="middle" fill="#7c2d12" fontSize={2.3} fontWeight="bold" fontFamily="monospace">
        {event.call}
      </text>
    </g>
  );
}

/** A dart that went down a hole. Somebody down there is pleased about it. */
function HoleTaunt({ event }: { event: EventView }) {
  return (
    <g className="wam-bonk">
      <Bubble area={event.area} text={event.call} tone="#fecaca" />
    </g>
  );
}

function Bubble({ area, text, tone }: { area: string; text: string; tone: string }) {
  const { x, y, flip } = bubbleAnchor(area);
  const width = Math.max(9, text.length * 1.25);
  const half = width / 2;

  return (
    <g className="wam-pop" style={{ transformOrigin: `${x}px ${y}px` }}>
      <path
        d={`M ${x - half} ${y - 3.2} h ${width} a 1.2 1.2 0 0 1 1.2 1.2 v 3.4 a 1.2 1.2 0 0 1 -1.2 1.2 h ${-width} a 1.2 1.2 0 0 1 -1.2 -1.2 v -3.4 a 1.2 1.2 0 0 1 1.2 -1.2 Z`}
        fill="#0f172a"
        stroke={tone}
        strokeWidth={0.28}
        opacity={0.96}
      />
      <path
        d={`M ${flip ? x + half - 1 : x - half + 1} ${y + 2.6} l ${flip ? 4.6 : -4.6} 3.4 l ${flip ? -2.2 : 2.2} -3.6 Z`}
        fill="#0f172a"
        stroke={tone}
        strokeWidth={0.28}
      />
      <text x={x} y={y + 0.4} textAnchor="middle" fill={tone} fontSize={2.3} fontFamily="monospace">
        {text}
      </text>
    </g>
  );
}

/** The moment the colony changes gear. One visit, then gone. */
function Banner({ stage }: { stage: 'enraged' | 'frenzy' }) {
  const frenzy = stage === 'frenzy';
  return (
    <g className="wam-banner">
      <rect x={0} y={42} width={100} height={14} fill={frenzy ? '#7f1d1d' : '#78350f'} opacity={0.88} />
      <text x={50} y={48.5} textAnchor="middle" fill="#fef3c7" fontSize={6.4} fontWeight="bold" fontFamily="monospace">
        {frenzy ? 'FRENZY!' : 'ENRAGED!'}
      </text>
      <text x={50} y={53.6} textAnchor="middle" fill="#fde68a" fontSize={2.6} fontFamily="monospace">
        {frenzy ? 'whack them the visit they appear' : 'the moles dig faster now'}
      </text>
    </g>
  );
}

// ============================================================
// The panel slot
// ============================================================

function Hud({ run }: { run: RunView }) {
  const stageText = run.stage === 'frenzy' ? 'FRENZY' : run.stage === 'enraged' ? 'ENRAGED' : 'DIGGING';
  const stageClass = run.stage === 'frenzy'
    ? 'bg-red-900 text-red-200'
    : run.stage === 'enraged'
      ? 'bg-amber-900 text-amber-200'
      : 'bg-gray-800 text-gray-400';

  return (
    <div className="w-full flex flex-col gap-2">
      <div className="bg-gray-900 rounded-lg px-4 py-2 flex items-center justify-between gap-3">
        <div>
          <p className="text-4xl font-bold font-mono text-amber-300 leading-none">{run.team}</p>
          <p className="text-[10px] uppercase text-gray-500 mt-1">
            {run.players.length > 1 ? 'team score' : 'score'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <p className="text-sm font-mono text-gray-300">
            Round <span className="text-gray-100">{run.round}</span>
            <span className="text-gray-600"> / {run.rounds}</span>
          </p>
          <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded ${stageClass}`}>{stageText}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        {run.players.map((player) => (
          <div
            key={player.id}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${
              player.isCurrent ? 'bg-green-900 border border-green-600' : 'bg-gray-900'
            }`}
          >
            <span className="flex-1 min-w-0 truncate text-sm text-gray-300">
              {player.out && <span className="mr-1">🪦</span>}
              {player.name}
            </span>
            <span className="font-mono text-lg text-amber-300 w-8 text-right">{player.score}</span>
            <span className="font-mono text-xs tracking-tighter w-12 text-right" title="darts per visit">
              {Array.from({ length: player.darts }).map((_, i) => {
                if (i < player.allowance) return <span key={i} className="text-green-400">●</span>;
                if (i < player.allowance + player.returning) return <span key={i} className="text-cyan-300">↺</span>;
                return <span key={i} className="text-red-800">✖</span>;
              })}
            </span>
          </div>
        ))}
      </div>

      <Burrow run={run} />

      {/* Always as many chips as there are moles in play, so the block keeps its height. */}
      <div>
        <p className="text-[10px] uppercase text-gray-500 mb-1">On the board</p>
        <div className="flex gap-1">
          {run.moles.map((mole) => {
            const left = Math.max(0, mole.digTime - mole.age);
            const chip = left <= 1
              ? 'bg-red-950 border-red-700 text-red-200'
              : left === 2
                ? 'bg-amber-950 border-amber-800 text-amber-200'
                : 'bg-gray-900 border-gray-700 text-gray-200';
            return (
              <div
                key={mole.id}
                data-area={mole.area}
                className={`flex-1 min-w-0 rounded border px-1 py-1 text-center ${chip}`}
              >
                <p className="font-mono text-sm truncate">{mole.label}</p>
                <Pips total={mole.digTime} left={left} />
              </div>
            );
          })}
          {Array.from({ length: Math.max(0, run.moleCount - run.moles.length) }).map((_, i) => (
            <div key={`gap-${i}`} className="flex-1 min-w-0 rounded border border-gray-800 px-1 py-1 text-center">
              <p className="font-mono text-sm text-gray-700">—</p>
              <Pips total={0} left={0} />
            </div>
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-4 gap-1 text-center">
        <Stat label="whacked" value={run.stats.whacked} tone="good" />
        <Stat label="holes" value={run.stats.holes} tone="danger" />
        <Stat label="saved" value={run.stats.rescued} tone="info" />
        <Stat label="perfect" value={run.stats.perfectVisits} tone="warn" />
      </dl>
    </div>
  );
}

/**
 * What is going on in the middle of the board.
 *
 * One line whatever the answer is, because it changes several times a run and the block under it
 * should not move when it does.
 */
function Burrow({ run }: { run: RunView }) {
  if (run.janitor) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-cyan-600 bg-cyan-950 px-3 py-1.5 wam-flash-soft">
        <span className="text-lg leading-none">🛠</span>
        <span className="min-w-0 flex-1 truncate text-xs text-cyan-200">
          Janitor has <span className="font-semibold">{run.janitor.ownerName}</span>'s dart
          {run.janitor.queue > 1 && <span className="text-cyan-500"> (+{run.janitor.queue - 1} more)</span>}
        </span>
        <span className="shrink-0 rounded bg-cyan-900 px-1.5 py-0.5 font-mono text-[10px] text-cyan-100">HIT BULL</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5">
      <span className="text-lg leading-none opacity-40">🕳</span>
      <span className="min-w-0 flex-1 truncate text-xs text-gray-500">
        {run.lost === 0
          ? 'The burrow is quiet'
          : `${run.lost} dart${run.lost === 1 ? '' : 's'} down the burrow`}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-gray-600">{run.lost > 0 ? 'janitor may call' : '—'}</span>
    </div>
  );
}

/** How many visits this mole has left, as a bar. Kept at one height whether it is full or empty. */
function Pips({ total, left }: { total: number; left: number }) {
  return (
    <div className="mt-1 flex h-[3px] gap-1">
      {Array.from({ length: Math.max(1, total) }).map((_, i) => (
        <span
          key={i}
          className={`flex-1 rounded-full ${total === 0 ? 'bg-gray-800' : i < left ? 'bg-current opacity-90' : 'bg-current opacity-20'}`}
        />
      ))}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'good' | 'warn' | 'danger' | 'info' }) {
  const colour = tone === 'danger'
    ? 'text-red-400'
    : tone === 'warn'
      ? 'text-amber-400'
      : tone === 'info'
        ? 'text-cyan-300'
        : 'text-green-400';
  return (
    <div className="bg-gray-900 rounded py-1">
      <dd className={`font-mono text-sm ${colour}`}>{value}</dd>
      <dt className="text-[9px] uppercase text-gray-600">{label}</dt>
    </div>
  );
}

// ============================================================
// The finale
// ============================================================

/**
 * How a run ends.
 *
 * Over the whole window, and while the last visit is still open — the match summary is the match's
 * screen and does not draw a mode's panel, so this is the only moment the run has to be told about.
 */
function Finale({ run, host }: { run: RunView; host: HTMLElement }) {
  return createPortal(
    // Exactly the board square, and nothing outside it: the rest of the screen — the score cards,
    // the slots, Submit — is what the player is being asked to look at next, and dimming the whole
    // window to say "game over" would hide the button that ends it.
    //
    // Sized in `cqw` against itself, so the whole card scales with the board rather than needing a
    // breakpoint per width. The board is a square from ~260px on a phone to ~600px on a desktop.
    <div
      className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-[1.5cqw] overflow-hidden border border-amber-700/50 bg-gray-950 p-[5cqw] text-center wam-fade [container-type:size]"
    >
      <p className="text-[2.6cqw] uppercase tracking-[0.3em] text-amber-500">the colony rests</p>
      <h2 className="text-[7.5cqw] font-bold leading-none text-amber-300">GAME OVER</h2>

      <p className="font-mono text-[24cqw] font-bold leading-none text-amber-200 wam-pop">{run.team}</p>
      <p className="text-[2.6cqw] uppercase tracking-wide text-gray-500">
        {run.players.length > 1 ? 'team score' : 'score'} after {run.round} of {run.rounds} rounds
      </p>

      <div className="mt-[2cqw] flex w-full flex-col gap-[1cqw]">
        {run.players.map((player) => (
          <div
            key={player.id}
            className="flex items-center justify-between rounded bg-gray-900 px-[3cqw] py-[1.4cqw]"
          >
            <span className="truncate text-[3.4cqw] text-gray-300">{player.name}</span>
            <span className="font-mono text-[4.4cqw] text-amber-300">{player.score}</span>
          </div>
        ))}
      </div>

      <dl className="mt-[1cqw] grid w-full grid-cols-4 gap-[1.2cqw]">
        <FinaleStat label="whacked" value={run.stats.whacked} colour="text-green-400" />
        <FinaleStat label="holes" value={run.stats.holes} colour="text-red-400" />
        <FinaleStat label="saved" value={run.stats.rescued} colour="text-cyan-300" />
        <FinaleStat label="perfect" value={run.stats.perfectVisits} colour="text-amber-400" />
      </dl>

      <p className="mt-[1.5cqw] text-[3cqw] text-gray-400">
        Press <span className="font-semibold text-green-400">Submit Visit</span> to finish
      </p>
    </div>,
    host,
  );
}

/** The finale's own tiles, which scale with the board rather than with the panel column. */
function FinaleStat({ label, value, colour }: { label: string; value: number; colour: string }) {
  return (
    <div className="rounded bg-gray-900 py-[1.2cqw]">
      <dd className={`font-mono text-[4cqw] ${colour}`}>{value}</dd>
      <dt className="text-[2.2cqw] uppercase text-gray-600">{label}</dt>
    </div>
  );
}

// ============================================================
// Movement
// ============================================================

/**
 * The mode's own keyframes, and the mallet.
 *
 * In a style element of its own rather than in the app's stylesheet, so it arrives and leaves with
 * the mode: no other mode pays for it, and nothing is left behind when the match ends.
 */
const CSS = `
@keyframes wam-rise { from { transform: translateY(9px) scale(0.4); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes wam-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-0.5px) } }
@keyframes wam-glow { 0%,100% { opacity: .3 } 50% { opacity: .58 } }
@keyframes wam-glow-hot { 0%,100% { opacity: .42 } 50% { opacity: .78 } }
@keyframes wam-edge { to { stroke-dashoffset: -3.6 } }
@keyframes wam-flash { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
@keyframes wam-bonk { 0% { transform: scale(0.2) rotate(-25deg); opacity: 0 } 55% { transform: scale(1.25) rotate(6deg); opacity: 1 } 100% { transform: scale(1) rotate(0); opacity: 1 } }
@keyframes wam-pop { 0% { transform: scale(0.5); opacity: 0 } 70% { transform: scale(1.08) } 100% { transform: scale(1); opacity: 1 } }
@keyframes wam-dug { 0% { opacity: 0; transform: scale(1.3) } 100% { opacity: 1; transform: none } }
@keyframes wam-steam { 0% { opacity: .2; transform: translateY(0) } 100% { opacity: 0; transform: translateY(-1.6px) } }
@keyframes wam-banner { 0% { opacity: 0; transform: translateX(-40px) } 20%,80% { opacity: 1; transform: none } 100% { opacity: 0; transform: translateX(40px) } }
@keyframes wam-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes wam-flash-soft { 0%,100% { border-color: #0891b2 } 50% { border-color: #67e8f9 } }

.wam-rise { animation: wam-rise .42s cubic-bezier(.2,1.4,.5,1) both }
.wam-bob { animation: wam-bob 2.4s ease-in-out infinite }
.wam-glow { animation: wam-glow 1.8s ease-in-out infinite }
.wam-glow-hot { animation: wam-glow-hot .8s ease-in-out infinite }
.wam-edge { animation: wam-edge 1.2s linear infinite }
.wam-flash { animation: wam-flash .7s steps(2,end) infinite }
.wam-bonk { animation: wam-bonk .38s cubic-bezier(.2,1.6,.4,1) both }
.wam-pop { animation: wam-pop .3s cubic-bezier(.2,1.5,.4,1) both }
.wam-dug { animation: wam-dug .5s ease-out both }
.wam-steam { animation: wam-steam 1.4s ease-out infinite }
.wam-banner { animation: wam-banner 2.6s ease-in-out both }
.wam-fade { animation: wam-fade .35s ease-out both }
.wam-flash-soft { animation: wam-flash-soft 1.1s ease-in-out infinite }

/*
 * A mallet, since that is what this is — but the mallet is not the cursor.
 *
 * A hammer head has no point, so a hotspot anywhere on it is a guess the player has to make about
 * their own aim. The crosshair at (15,50) is the cursor; the mallet is held above and to the right
 * of it, clear of the arms so it never sits over the thing it is telling you about. Every line is
 * drawn twice, dark under light, because the board it moves across is half cream and half black.
 *
 * The canvas is the two of them and almost nothing else — 50×66 is where the mallet's corners and
 * the crosshair's arm tips land, so moving or resizing either means working the bounds out again
 * rather than hoping the old box still covers it.
 *
 * It replaces the board's cursor-crosshair and only that. The board turns the cursor off entirely
 * while a hold is aiming, because the oversized dart is the pointer then, and shows not-allowed
 * when the visit will take no more darts; a mallet over either of those would be lying. Both are
 * excluded by name rather than by luck: this rule and Tailwind's carry the same specificity, so
 * without the :not()s whichever stylesheet came last would win.
 */
[data-testid="dartboard"]:not(.cursor-none):not(.cursor-not-allowed) { cursor: url("data:image/svg+xml;utf8,\
<svg xmlns='http://www.w3.org/2000/svg' width='50' height='66' viewBox='0 0 50 66'>\
<g transform='translate(31 23) rotate(135) scale(1.5)'>\
<rect x='-2.1' y='-14' width='4.2' height='15' rx='2' fill='%23a16207' stroke='%23422006' stroke-width='1'/>\
<rect x='-8.5' y='1' width='17' height='9' rx='2.4' fill='%23dc2626' stroke='%23450a0a' stroke-width='1'/>\
<rect x='-7.4' y='2' width='14.8' height='3' rx='1.5' fill='%23f87171' opacity='.6'/>\
</g>\
<g stroke-linecap='round'>\
<path d='M15 38V45.5 M15 54.5V62 M3 50H10.5 M19.5 50H27' stroke='%23000' stroke-width='5.1' opacity='.6'/>\
<path d='M15 38V45.5 M15 54.5V62 M3 50H10.5 M19.5 50H27' stroke='%23fff' stroke-width='2.25'/>\
</g></svg>") 15 50, crosshair }

@media (prefers-reduced-motion: reduce) {
  .wam-rise, .wam-bob, .wam-glow, .wam-glow-hot, .wam-edge, .wam-flash, .wam-flash-soft, .wam-bonk, .wam-pop, .wam-dug, .wam-steam, .wam-banner, .wam-fade {
    animation-duration: .01ms; animation-iteration-count: 1;
  }
}
`;

function Styles() {
  return createPortal(<style>{CSS}</style>, document.head);
}
