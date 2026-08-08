import { useEffect, useState } from 'react';

/**
 * Take the browser's chrome off, for the two screens that want the whole display: a phone mounted
 * at a board, and a scoreboard on a television.
 *
 * Renders nothing where the platform has no element fullscreen — which is iPhone Safari, where only
 * a `<video>` can go fullscreen. A button that throws is worse than no button, and there is nothing
 * to offer instead short of an installed web app.
 *
 * The label follows `document.fullscreenElement` rather than its own memory of what was pressed,
 * because Android's back gesture and the Escape key both leave fullscreen without telling anyone.
 */
export function FullscreenButton({ className = '' }: { className?: string }) {
  const [full, setFull] = useState(false);
  const [supported] = useState(
    () => typeof document !== 'undefined' && typeof document.documentElement.requestFullscreen === 'function',
  );

  useEffect(() => {
    if (!supported) return;
    const sync = () => setFull(document.fullscreenElement !== null);
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [supported]);

  if (!supported) return null;

  const toggle = () => {
    const action = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    // Refused — no user activation, or a platform that only pretends to support it. The label is
    // driven by the event, so leaving it alone leaves it honest.
    void action.catch(() => {});
  };

  return (
    <button
      onClick={toggle}
      title={full ? 'Leave full screen' : 'Full screen'}
      aria-label={full ? 'Leave full screen' : 'Full screen'}
      data-testid="fullscreen"
      className={`px-2 py-1 text-sm bg-gray-800 hover:bg-gray-700 rounded transition-colors ${className}`}
    >
      <svg viewBox="0 0 16 16" className="w-4 h-4 fill-none stroke-current stroke-[1.5]" aria-hidden="true">
        {full ? (
          <path d="M6 1v5H1M10 15v-5h5" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M1 6V1h5M15 10v5h-5" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </button>
  );
}
