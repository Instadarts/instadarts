import { useEffect, useRef } from 'react';
import { Box } from '@mantine/core';
import { boardWarpMatrix, type BoardGeometry } from '../../shared/vision/feedGeometry';
import { BOARD_CUTOUT, toMatrix3d } from './boardWarp';

interface LiveBoardFeedProps {
  source: HTMLCanvasElement;
  label?: string;
  /** Resting framing of the painted frame, read independently of React renders. */
  restingGeometry?: () => BoardGeometry | null;
  /** Lay the board square-on over the virtual board underneath, and cut the rest away. */
  straighten?: boolean;
}

/**
 * Mount the receiver's canvas directly. Straightening transforms the inner box; the circular clip
 * belongs to its untransformed parent so the clip itself stays round. See docs/media.md.
 */
export function LiveBoardFeed({ source, label, restingGeometry, straighten = false }: LiveBoardFeedProps) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  /** The board box's side, in CSS pixels. Kept current so the frame loop never measures. */
  const size = useRef(0);
  // The getter changes on renders; the animation loop only needs its latest value.
  const latestGeometry = useRef(restingGeometry);
  latestGeometry.current = restingGeometry;

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

  // Follow decoded geometry and resize updates without rendering React or copying pixels.
  useEffect(() => {
    const box = host.current;
    const target = frame.current;
    if (!box || !target) return;
    // Toggling off runs the previous effect's cleanup and releases the frame callback.
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
