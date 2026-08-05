import type { DartThrow } from '../../shared/types';
import { Dartboard } from './Dartboard';

interface VisitInputProps {
  darts: DartThrow[];
  onAddDart: (dart: DartThrow) => void;
  onUndoDart: () => void;
  onSubmit: () => void;
  disabled?: boolean;
}

export function VisitInput({ darts, onAddDart, onUndoDart, onSubmit, disabled }: VisitInputProps) {
  return (
    <div className="flex flex-col items-center gap-4">
      <Dartboard darts={darts} onDartClick={onAddDart} disabled={disabled} />

      {/* Dart labels and scores */}
      <div className="flex gap-3 min-h-[40px]">
        {darts.map((dart, i) => (
          <div
            key={i}
            className={`px-4 py-1 rounded font-mono text-lg ${
              dart.score.points > 0 ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
            }`}
          >
            {dart.score.label} ({dart.score.points})
          </div>
        ))}
        {Array.from({ length: 3 - darts.length }).map((_, i) => (
          <div key={`empty-${i}`} className="px-4 py-1 rounded bg-gray-800 text-gray-600 font-mono text-lg">
            --
          </div>
        ))}
      </div>

      {/* Visit total */}
      {darts.length > 0 && (
        <p className="text-xl font-bold text-yellow-400">
          Visit: {darts.reduce((s, d) => s + d.score.points, 0)}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-4">
        <button
          onClick={onUndoDart}
          disabled={darts.length === 0 || disabled}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded transition-colors"
        >
          Undo
        </button>
        <button
          onClick={onSubmit}
          disabled={disabled}
          className="px-6 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 rounded font-semibold transition-colors"
        >
          Submit Visit
        </button>
      </div>
    </div>
  );
}
