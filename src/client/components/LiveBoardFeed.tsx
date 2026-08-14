import { useEffect, useRef } from 'react';

interface LiveBoardFeedProps {
  source: HTMLCanvasElement;
  label?: string;
}

/**
 * The production board picture.
 *
 * The receiver owns `source` and keeps painting decoded frames into it whether this component is
 * mounted or not. Mounting that canvas directly keeps the surface raw and avoids a second canvas,
 * pixel copy, or animation loop.
 */
export function LiveBoardFeed({ source, label }: LiveBoardFeedProps) {
  const target = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = target.current;
    if (!host) return;
    const previousStyle = source.style.cssText;
    source.style.width = '100%';
    source.style.height = '100%';
    source.style.display = 'block';
    host.appendChild(source);
    return () => {
      if (source.parentNode === host) host.removeChild(source);
      source.style.cssText = previousStyle;
    };
  }, [source]);

  return (
    <div
      ref={target}
      data-testid="live-board-feed"
      role="img"
      aria-label={label ? `Live board video: ${label}` : 'Live board video'}
      className="absolute inset-0 z-10 w-full h-full pointer-events-none"
    />
  );
}
