// Text that copies itself when clicked, and says so.
//
// The saying-so is the point. Copying is invisible — nothing on screen changes, the clipboard is
// somewhere else — so without an acknowledgement the only way to find out whether a click worked is
// to go and paste it somewhere, which is exactly the trip the button existed to save.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Tooltip, UnstyledButton, VisuallyHidden } from '@mantine/core';

/**
 * Put `text` on the clipboard, by whichever route this browser allows.
 *
 * **`navigator.clipboard` is not always there.** It requires a secure context, and the ordinary way
 * to run this app — a machine on the home network, reached over plain http — is not one. That is
 * the same rule that stops the scoring phone opening its camera, and it would silently take this
 * button with it. So the deprecated `execCommand` path is not legacy support for old browsers; it
 * is the path a current browser takes on a LAN, and it is the one that will run most often.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Present but refused — a permission policy, or a document that was not focused. Try the other.
  }

  try {
    // Off-screen rather than hidden: a `display: none` textarea cannot be selected, and an element
    // that is not selectable cannot be copied from.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

/** How long the acknowledgement stays up. Long enough to be read, short enough not to be in the way. */
const FLASH_MS = 1400;

interface CopyableTextProps {
  /** What lands on the clipboard. Also what is shown, unless `children` says otherwise. */
  value: string;
  children?: React.ReactNode;
}

export function CopyableText({ value, children }: CopyableTextProps) {
  const [flash, setFlash] = useState<'copied' | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A click while the acknowledgement is still up restarts it rather than stacking a second timer,
  // which would otherwise clear the message early — the first timer firing during the second flash.
  const announce = useCallback((result: 'copied' | 'failed') => {
    if (timer.current) clearTimeout(timer.current);
    setFlash(result);
    timer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <Tooltip
      opened={flash !== null}
      label={flash === 'failed' ? 'Select it and copy by hand' : 'Copied'}
      color={flash === 'failed' ? 'yellow' : 'dark'}
      position="top"
      withArrow
    >
      <UnstyledButton
        onClick={() => { void copyToClipboard(value).then((ok) => announce(ok ? 'copied' : 'failed')); }}
        title="Copy to clipboard"
        style={{ display: 'inline-block', color: 'inherit', font: 'inherit', userSelect: 'text' }}
      >
        {children ?? value}
        <VisuallyHidden aria-live="polite">
          {flash === 'failed' ? 'Copy failed. Select it and copy by hand.' : flash === 'copied' ? 'Copied.' : ''}
        </VisuallyHidden>
      </UnstyledButton>
    </Tooltip>
  );
}
