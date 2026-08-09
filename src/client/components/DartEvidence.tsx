// The row of photographs under the dart slots: what the board camera saw where each dart landed.
//
// **The strip is its final height from the moment it exists.** Slots with no picture yet hold an
// empty box of the same size, so the first still to arrive fills a gap rather than pushing the board
// upward — see "a screen that does not jump" in docs/game-modes.md. It exists whenever a board
// camera is in play, which is knowable before any picture is, and not at all otherwise: a user with
// media off sees the match screen exactly as it was.
//
// Tapping one opens it full size, because sixty pixels tells you a dart is there and not which side
// of the wire it is on — and reading it is the entire point.

import { useState } from 'react';

interface DartEvidenceProps {
  /** One entry per dart slot; undefined where no picture has arrived. */
  images: (string | undefined)[];
  /** How many slots the visit has, so the strip matches the row above it. */
  slots: number;
}

export function DartEvidence({ images, slots }: DartEvidenceProps) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <div className="flex gap-3 w-full justify-center" data-testid="dart-evidence">
        {Array.from({ length: slots }).map((_, i) => {
          const src = images[i];
          return (
            <div key={i} className="flex-1 max-w-[10rem] aspect-square rounded overflow-hidden bg-gray-800">
              {src && (
                <button
                  onClick={() => setOpen(src)}
                  className="w-full h-full block cursor-zoom-in"
                  aria-label={`Dart ${i + 1} evidence`}
                >
                  <img src={src} alt="" className="w-full h-full object-cover" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {open && <StillViewer src={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** One still, as large as the window allows. Dismissed by tapping anywhere — including the picture. */
function StillViewer({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Dart evidence"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 cursor-zoom-out"
    >
      <img src={src} alt="" className="max-w-full max-h-full rounded" />
    </div>
  );
}
