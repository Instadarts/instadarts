import { useCallback } from 'react';
import type { DartThrow, MatchState, ModeView } from '../../shared/types';
import { textOf } from '../../shared/types';
import { VisitInput } from '../components/VisitInput';
import { modeTextClasses } from '../components/modeText';
import { MODE_PANELS } from '../modes/panels';

interface MatchScreenProps {
  match: MatchState;
  view: ModeView;
  onLeave: () => void;
  onAddDart: (matchId: string, dart: DartThrow) => void;
  onUndoDart: (matchId: string) => void;
  onSubmitVisit: (matchId: string) => void;
  ownPlayerId: string | null;
  isSpectator: boolean;
}

/**
 * The match screen: universal chrome only.
 *
 * Every mode-specific value — the headline, what is on a player's card, the visit total, the history
 * lines — arrives in `view`, computed by the game mode on the server. Nothing here knows what a bust
 * or a checkout is, and adding a game mode does not change this file.
 */
export function MatchScreen({ match, view, onLeave, onAddDart, onUndoDart, onSubmitVisit, ownPlayerId, isSpectator }: MatchScreenProps) {
  const currentPlayer = match.players[match.currentPlayerIndex];
  const isMyTurn = !isSpectator && match.status === 'in_progress' && (!ownPlayerId || currentPlayer.id === ownPlayerId);

  const currentDarts = match.currentVisit?.darts ?? [];
  const visitLocked = match.currentVisit?.locked ?? false;
  const canAddDart = isMyTurn && !visitLocked && currentDarts.length < view.dartsPerVisit && match.status === 'in_progress';

  const handleAddDart = useCallback((dart: DartThrow) => {
    onAddDart(match.id, dart);
  }, [match.id, onAddDart]);

  const handleUndo = useCallback(() => {
    onUndoDart(match.id);
  }, [match.id, onUndoDart]);

  const handleSubmit = useCallback(() => {
    onSubmitVisit(match.id);
  }, [match.id, onSubmitVisit]);

  const ModePanel = MODE_PANELS[match.settings.mode];

  return (
    <div className="flex-1 flex flex-col items-center p-4 gap-6">
      <h2 className={modeTextClasses(view.headline, { tone: 'accent', size: '2xl', weight: 'bold' })}>
        {textOf(view.headline)}
        {isSpectator && <span className="text-yellow-400 text-base ml-2">(spectating)</span>}
      </h2>

      {/* Score panel */}
      <div className="flex gap-8">
        {match.players.map((p, i) => {
          const isCurrent = i === match.currentPlayerIndex;
          const score = view.playerScores[p.id] ?? '';
          return (
            <div
              key={p.id}
              className={`text-center px-6 py-4 rounded-lg min-w-[120px] ${
                isCurrent ? 'bg-green-900 border border-green-500' : 'bg-gray-900'
              }`}
            >
              <p className="text-sm text-gray-400">{p.name}</p>
              {/* Whose turn it is is ours to colour; anything the mode wants to say about the score
                  itself overrides it. */}
              <p
                className={modeTextClasses(
                  score,
                  { tone: isCurrent ? 'accent' : 'default', size: '4xl', weight: 'bold' },
                  'font-mono',
                )}
              >
                {textOf(score)}
              </p>
              {isCurrent && match.status === 'in_progress' && (
                <p className="text-xs text-green-500 mt-1">▶ throwing</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Status bar */}
      {match.status === 'finished' && (
        <div className="text-center">
          <p className="text-2xl text-yellow-400 font-bold">
            🎯 {match.players.find((p) => p.id === match.winnerId)?.name ?? 'Unknown'} wins!
          </p>
        </div>
      )}

      {view.notice && isMyTurn && (
        <p className={modeTextClasses(view.notice, { tone: 'warning', weight: 'semibold' })}>
          {textOf(view.notice)}
        </p>
      )}

      {/* The mode's own element. Nothing is rendered for a mode that does not use it. */}
      {ModePanel && view.panel !== undefined && <ModePanel payload={view.panel} />}

      {/* Dartboard / Visit Input */}
      {match.status === 'in_progress' && (
        <div className="w-full max-w-[500px]">
          <VisitInput
            darts={currentDarts}
            dartsPerVisit={view.dartsPerVisit}
            slots={view.slots}
            visitTotal={view.visitTotal}
            onAddDart={isSpectator ? () => {} : handleAddDart}
            onUndoDart={isSpectator ? () => {} : handleUndo}
            onSubmit={isSpectator ? () => {} : handleSubmit}
            disabled={!canAddDart}
            locked={visitLocked}
            readOnly={!isMyTurn || isSpectator}
            hideActions={isSpectator}
          />
        </div>
      )}

      {/* Visit history */}
      <div className="w-80 max-h-48 overflow-y-auto">
        <h3 className="text-gray-400 text-sm uppercase mb-2">Visit History</h3>
        {view.history.slice(0, 12).map((line, i) => (
          <div
            key={i}
            className={modeTextClasses(line, { size: 'sm' }, 'py-1 px-2 font-mono whitespace-pre-wrap')}
          >
            {textOf(line)}
          </div>
        ))}
      </div>

      {/* Actions */}
      <button
        onClick={onLeave}
        className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
      >
        {match.status === 'finished' ? 'Exit' : 'Leave Match'}
      </button>
    </div>
  );
}
