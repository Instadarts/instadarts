import type { DartThrow, ViewText } from '../../shared/types';
import { textOf } from '../../shared/types';
import { Dartboard } from './Dartboard';
import { DartEvidence } from './DartEvidence';
import { modeTextClasses, slotClasses } from './modeText';
import { LiveBoardFeed } from './LiveBoardFeed';

export interface LiveBoardView {
  canvas: HTMLCanvasElement;
  label?: string;
}

interface VisitInputProps {
  darts: DartThrow[];
  /** How many slots the visit has. The game mode decides. */
  dartsPerVisit: number;
  /** Slot contents from the mode. Omitted → each dart's own label. */
  slots?: ViewText[];
  /** The `Visit: <total>` line. Empty text hides it. */
  visitTotal: ViewText;
  onAddDart: (dart: DartThrow) => void;
  onUndoDart: () => void;
  onSubmit: () => void;
  disabled?: boolean;
  locked?: boolean;
  readOnly?: boolean;
  hideActions?: boolean;
  /**
   * A photograph per dart slot from the board camera, or null where no camera is in play.
   *
   * Null and empty mean different things: null draws nothing at all, an empty array draws the strip
   * at full height waiting to be filled. That is the difference between a user who is not using the
   * feature and one whose first still has not arrived yet.
   */
  evidence: (string | undefined)[] | null;
  /** A fresh remote board feed. Null leaves the always-mounted virtual board visible. */
  liveBoard?: LiveBoardView | null;
}

/** One dart's slot: an equal share of the row, within limits that keep a label readable. */
const SLOT = 'flex-1 max-w-[10rem] py-1 rounded';

export function VisitInput({
  darts,
  dartsPerVisit,
  slots,
  visitTotal,
  onAddDart,
  onUndoDart,
  onSubmit,
  disabled,
  locked,
  readOnly,
  hideActions,
  evidence,
  liveBoard,
}: VisitInputProps) {
  const boardDisabled = disabled || darts.length >= dartsPerVisit || (locked ?? false) || (readOnly ?? false);
  // A mode that says nothing about its slots gets each dart's own label, untoned.
  const filled: ViewText[] = slots ?? darts.map((dart) => `${dart.score.label} (${dart.score.points})`);
  const empty = Math.max(0, dartsPerVisit - filled.length);

  return (
    <div className="flex flex-col items-center gap-2 w-full lg:flex-1 lg:min-h-0">
      {/* The board gets whatever height the slots and buttons below it do not need, and is told
          how much that is: `container-type: size` is what makes `cqh` inside mean this box, which
          is how the board can be the largest square that fits without measuring anything in JS. */}
      <div className="w-full flex justify-center lg:flex-1 lg:min-h-0 lg:[container-type:size]">
        <Dartboard darts={darts} maxDarts={dartsPerVisit} onDartClick={onAddDart} disabled={boardDisabled}>
          {liveBoard && (
            <LiveBoardFeed source={liveBoard.canvas} label={liveBoard.label} />
          )}
        </Dartboard>
      </div>

      {/* Dart slots. They share the row the way the board shares its column, so the two stay in
          proportion as the window grows rather than the board running away from them. */}
      <div className="flex gap-3 min-h-[40px] w-full justify-center">
        {filled.map((slot, i) => (
          <div key={i} className={slotClasses(slot, { size: 'lg' }, `${SLOT} font-mono text-center`)}>
            {textOf(slot)}
          </div>
        ))}
        {Array.from({ length: empty }).map((_, i) => (
          <div key={`empty-${i}`} className={`${SLOT} bg-gray-800 text-gray-600 font-mono text-lg text-center`}>
            --
          </div>
        ))}
      </div>

      {/* What the camera saw. Present from the first frame of the visit whenever a board camera is
          in play, so the first picture to arrive fills a gap instead of moving the board. */}
      {evidence && <DartEvidence images={evidence} slots={dartsPerVisit} />}

      {/* Visit total — the mode decides whether there is one to show */}
      {textOf(visitTotal) !== '' && (
        <p className={modeTextClasses(visitTotal, { tone: 'warning', size: 'xl', weight: 'bold' })}>
          Visit: {textOf(visitTotal)}
        </p>
      )}

      {/* Actions */}
      {!hideActions && (
      <div className="flex gap-2">
        <button
          onClick={onUndoDart}
          disabled={darts.length === 0 || (readOnly ?? false)}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded transition-colors"
        >
          Undo
        </button>
        <button
          onClick={onSubmit}
          disabled={readOnly ?? false}
          className="px-6 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 rounded font-semibold transition-colors"
        >
          Submit Visit
        </button>
      </div>
      )}
    </div>
  );
}
