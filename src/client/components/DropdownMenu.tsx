import { useEffect, useId, useRef, type ReactNode } from 'react';

interface DropdownMenuProps {
  /** Trigger contents, and therefore its accessible name. The chevron is hidden from it. */
  label: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Extra classes for the trigger, e.g. the tint the device menu takes on while cameras score. */
  triggerClassName?: string;
  children: ReactNode;
}

/**
 * A panel that hangs off a button in the top bar instead of growing the bar itself.
 *
 * Growing the bar reflows the page under it, and the match screen is built to fill exactly the
 * height it was given — opening a menu there used to shove the board. An overlay costs the page
 * nothing.
 *
 * Controlled rather than self-managing its own boolean, so a bar with several of these can keep at
 * most one open. That is the whole reason this is a component and not a `{open && …}` in the bar.
 */
export function DropdownMenu({ label, open, onOpenChange, triggerClassName = '', children }: DropdownMenuProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Only while open: nothing to listen for otherwise, and a closed menu that still holds document
  // listeners is how a page ends up with one per menu per render.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onOpenChange(false);
      // Escape without this leaves focus on a panel that is gone.
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div className="relative" ref={wrapper}>
      <button
        ref={trigger}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={panelId}
        className={`flex items-center gap-1 px-3 py-1 text-sm rounded transition-colors bg-gray-800 hover:bg-gray-700 ${triggerClassName}`}
      >
        {label}
        <svg viewBox="0 0 16 16" className="w-3 h-3 fill-none stroke-current stroke-[1.5]" aria-hidden="true">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          id={panelId}
          // Anchored to the right edge of its trigger, and as wide as it can be without touching the
          // sides of a phone. Tall menus scroll inside themselves rather than off the screen.
          className="absolute right-0 top-full mt-1 z-50 w-[min(24rem,calc(100vw-1rem))] max-h-[calc(100dvh-4rem)] overflow-y-auto rounded border border-gray-800 bg-gray-900 shadow-xl p-3 flex flex-col gap-3 text-left"
        >
          {children}
        </div>
      )}
    </div>
  );
}
