import { useEffect, useRef } from 'react';
import { Box } from '@mantine/core';
import { boardWarpMatrix, type BoardGeometry } from '../../shared/vision/feedGeometry';
import { BOARD_CUTOUT, toMatrix3d } from './boardWarp';

interface LiveBoardFeedProps {
  source: HTMLCanvasElement;
  label?: string;
  /**
   * Where the board is in the picture, asked rather than passed. See `VideoFeedView.geometry` — it
   * arrives with a decoded frame, and nothing re-renders React when it does.
   */
  geometry?: () => BoardGeometry | null;
  /** Lay the board square-on over the virtual board underneath, and cut the rest away. */
  straighten?: boolean;
}

/**
 * The production board picture.
 *
 * The receiver owns `source` and keeps painting decoded frames into it whether this component is
 * mounted or not. Mounting that canvas directly keeps the surface raw and avoids a second canvas,
 * pixel copy, or animation loop.
 *
 * ## Straightening it
 *
 * A board photographed from off to one side arrives as a lopsided ellipse, laid over a perfectly
 * round drawing of the same board. Given the geometry the feed carries, one CSS `matrix3d` puts it
 * square-on and in register — because a `matrix3d` on a flat element **is** a homography, and on
 * this end nothing reads the bitmap. (`vision/videoCamera.ts` argues at length that CSS cannot do
 * this. That is about the *publisher*, where `drawImage`, `new VideoFrame(...)` and `captureStream()`
 * all read pixels and a compositor transform would reach none of them. Here the only consumer is an
 * eye.)
 *
 * Two boxes, and the nesting is load-bearing: **`clip-path` resolves in an element's own
 * coordinate space, before its transform**, so a circle on the warped box would itself come out
 * warped. The clip goes on the outer box, which stays where the virtual board is.
 */
export function LiveBoardFeed({ source, label, geometry, straighten = false }: LiveBoardFeedProps) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  /** The board box's side, in CSS pixels. Kept current so the frame loop never measures. */
  const size = useRef(0);
  /**
   * The getter, held rather than depended on.
   *
   * `useVideoFeed` derives its feeds — and this function with them — on every render, so depending
   * on it directly would tear the loop below down and rebuild it every time a dart landed. Reading
   * the latest one through a ref keeps the loop's lifetime tied to what it is actually about.
   */
  const latestGeometry = useRef(geometry);
  latestGeometry.current = geometry;

  useEffect(() => {
    const target = frame.current;
    if (!target) return;
    const previousStyle = source.style.cssText;
    source.style.width = '100%';
    source.style.height = '100%';
    source.style.display = 'block';
    target.appendChild(source);
    return () => {
      if (source.parentNode === target) target.removeChild(source);
      source.style.cssText = previousStyle;
    };
  }, [source]);

  // The matrix's perspective row carries units of 1/px, so it depends on how big the board is drawn.
  // Measured here rather than in the loop below: reading layout on a frame that has just written a
  // style is what turns a cheap read into a forced reflow.
  useEffect(() => {
    const box = host.current;
    if (!box) return;
    const read = (width: number, height: number) => { size.current = Math.min(width, height); };
    read(box.clientWidth, box.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) read(rect.width, rect.height);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  /**
   * The display's clock, because neither thing this reads has one React can hear: the geometry lands
   * with a decoded frame, the box's side comes from a `ResizeObserver`, and a mounted match
   * re-renders on neither.
   *
   * It does almost nothing on almost every tick. A camera describes only its resting framing, and
   * re-solves that only when its motion gate fires between throws, so the receiver replaces the
   * geometry object seldom — and the ordinary tick is two reference comparisons and a return. Both
   * properties it writes when it does write are the compositor's.
   */
  useEffect(() => {
    const box = host.current;
    const target = frame.current;
    if (!box || !target) return;
    // Nothing to follow while the feed is drawn the way it always was, and no reason to hold a frame
    // callback open for every viewer who never asked for this — which is most of them, it being off
    // by default. Toggling rebuilds the loop, and the cleanup below has cleared both properties by
    // the time this line is reached again.
    if (!straighten) return;

    let handle = 0;
    let lastGeometry: BoardGeometry | null = null;
    let lastSize = -1;
    let applied = '';

    const tick = () => {
      handle = requestAnimationFrame(tick);
      const read = latestGeometry.current;
      const current = read ? read() : null;
      const side = size.current;
      if (current === lastGeometry && side === lastSize) return;
      lastGeometry = current;
      lastSize = side;

      // No geometry, a box with no extent, or a shot this transform cannot honestly place: the feed
      // is the stretched square it has always been, uncut. A wrong warp would be worse than none,
      // and a circular hole cut out of an unrectified picture would be worse still.
      const matrix = current && side > 0 ? boardWarpMatrix(current, side) : null;
      const next = matrix ? toMatrix3d(matrix) : '';
      if (next === applied) return;
      applied = next;
      target.style.transform = next;
      box.style.clipPath = next ? BOARD_CUTOUT : '';
    };

    tick();
    return () => {
      cancelAnimationFrame(handle);
      target.style.transform = '';
      box.style.clipPath = '';
    };
  }, [straighten]);

  return (
    <Box
      ref={host}
      data-testid="live-board-feed"
      role="img"
      aria-label={label ? `Live board video: ${label}` : 'Live board video'}
      pos="absolute"
      inset={0}
      style={{ zIndex: 10, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      <Box ref={frame} pos="absolute" inset={0} style={{ transformOrigin: '0 0' }} />
    </Box>
  );
}
