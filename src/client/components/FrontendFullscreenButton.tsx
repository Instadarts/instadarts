import { useEffect, useState } from 'react';
import { ActionIcon } from '@mantine/core';

/** Mantine fullscreen control for the regular frontend; the scorer keeps its existing component. */
export function FrontendFullscreenButton() {
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
    void action.catch(() => {});
  };

  const label = full ? 'Leave full screen' : 'Full screen';
  return (
    <ActionIcon
      variant="default"
      size="lg"
      onClick={toggle}
      title={label}
      aria-label={label}
      data-testid="fullscreen"
    >
      <svg
        viewBox="0 0 16 16"
        width={20}
        height={20}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        {full ? (
          <path d="M6 1v5H1M10 15v-5h5" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M1 6V1h5M15 10v5h-5" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </ActionIcon>
  );
}
