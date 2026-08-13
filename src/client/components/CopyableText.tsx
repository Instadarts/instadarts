// Text that copies itself when clicked, and says so.
//
// The saying-so is the point. Copying is invisible — nothing on screen changes, the clipboard is
// somewhere else — so without an acknowledgement the only way to find out whether a click worked is
// to go and paste it somewhere, which is exactly the trip the button existed to save.

import { useCallback, useEffect, useRef, useState } from 'react';

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
  /**
   * How the clickable text looks, including its hover.
   *
   * Deliberately the caller's business rather than this component's: an invite code is already
   * green and a url is not, so a hover colour baked in here would be wrong for one of them — and
   * two Tailwind `hover:text-*` utilities on one element do not resolve by the order they are
   * written in, so a caller could not reliably override it.
   */
  className?: string;
}

export function CopyableText({ value, children, className = '' }: CopyableTextProps) {
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
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => { void copyToClipboard(value).then((ok) => announce(ok ? 'copied' : 'failed')); }}
        title="Copy to clipboard"
        // `select-text` is not decoration: browsers put `user-select: none` on a button, and the
        // message shown when both copy routes fail asks the reader to select the text by hand.
        // Without this that advice would be impossible to follow — and hand-selecting is also what
        // somebody does when they want half of a url, which no copy button will ever offer.
        className={`cursor-pointer select-text transition-colors ${className}`}
      >
        {children ?? value}
      </button>

      {/* Always mounted, so it can fade both ways — a conditionally rendered element appears at full
          opacity however it is styled. `pointer-events-none` throughout: it sits over the button it
          belongs to, and must never eat the second click. */}
      <span
        aria-live="polite"
        // `z-10` and a shadow, because this lands on top of whatever label sits above the thing it
        // belongs to — "Invite Code", in the lobby. Without them it reads as two pieces of text
        // colliding; with them it reads as what it is, a chip floating over the page for a second.
        className={`pointer-events-none absolute bottom-full left-1/2 z-10 -translate-x-1/2 mb-1 px-2 py-0.5 rounded shadow-md text-xs whitespace-nowrap transition-all duration-200 ${
          flash ? 'opacity-100 -translate-y-0.5' : 'opacity-0'
        } ${flash === 'failed' ? 'bg-yellow-900 text-yellow-200' : 'bg-gray-700 text-gray-100'}`}
      >
        {flash === 'failed' ? 'Select it and copy by hand' : flash === 'copied' ? 'Copied' : ''}
      </span>
    </span>
  );
}
