import type { DartThrow, ViewText } from '../../shared/types';
import { textOf } from '../../shared/types';
import { Dartboard } from './Dartboard';
import { modeTextClasses, slotClasses } from './modeText';

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
}

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
}: VisitInputProps) {
  const boardDisabled = disabled || darts.length >= dartsPerVisit || (locked ?? false) || (readOnly ?? false);
  // A mode that says nothing about its slots gets each dart's own label, untoned.
  const filled: ViewText[] = slots ?? darts.map((dart) => `${dart.score.label} (${dart.score.points})`);
  const empty = Math.max(0, dartsPerVisit - filled.length);

  return (
    <div className="flex flex-col items-center gap-4">
      <Dartboard darts={darts} maxDarts={dartsPerVisit} onDartClick={onAddDart} disabled={boardDisabled} />

      {/* Dart slots */}
      <div className="flex gap-3 min-h-[40px]">
        {filled.map((slot, i) => (
          <div key={i} className={slotClasses(slot, { size: 'lg' }, 'w-[105px] py-1 rounded font-mono text-center')}>
            {textOf(slot)}
          </div>
        ))}
        {Array.from({ length: empty }).map((_, i) => (
          <div key={`empty-${i}`} className="w-[105px] py-1 rounded bg-gray-800 text-gray-600 font-mono text-lg text-center">
            --
          </div>
        ))}
      </div>

      {/* Visit total — the mode decides whether there is one to show */}
      {textOf(visitTotal) !== '' && (
        <p className={modeTextClasses(visitTotal, { tone: 'warning', size: 'xl', weight: 'bold' })}>
          Visit: {textOf(visitTotal)}
        </p>
      )}

      {/* Actions */}
      {!hideActions && (
      <div className="flex gap-4">
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
