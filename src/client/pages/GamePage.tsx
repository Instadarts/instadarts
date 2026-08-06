import { useCallback } from 'react';
import type { GameState, DartThrow } from '../../shared/types';
import { VisitInput } from '../components/VisitInput';

interface GamePageProps {
  game: GameState;
  onLeave: () => void;
  onAddDart: (gameId: string, dart: DartThrow) => void;
  onUndoDart: (gameId: string) => void;
  onSubmitVisit: (gameId: string) => void;
  ownPlayerId: string | null;
  isSpectator: boolean;
}

export function GamePage({ game, onLeave, onAddDart, onUndoDart, onSubmitVisit, ownPlayerId, isSpectator }: GamePageProps) {
  const currentPlayer = game.players[game.currentPlayerIndex];
  const isMyTurn = !isSpectator && game.status === 'in_progress' && (!ownPlayerId || currentPlayer.id === ownPlayerId);

  const currentDarts = game.currentVisit?.darts ?? [];
  const visitLocked = game.currentVisit?.locked ?? false;
  const canAddDart = isMyTurn && !visitLocked && currentDarts.length < 3 && game.status === 'in_progress';

  const handleAddDart = useCallback((dart: DartThrow) => {
    onAddDart(game.id, dart);
  }, [game.id, onAddDart]);

  const handleUndo = useCallback(() => {
    onUndoDart(game.id);
  }, [game.id, onUndoDart]);

  const handleSubmit = useCallback(() => {
    onSubmitVisit(game.id);
  }, [game.id, onSubmitVisit]);

  const getRemaining = (playerId: string): number => {
    let remaining = game.settings.startScore;
    for (const visit of game.visits) {
      if (visit.playerId !== playerId || visit.bust) continue;
      remaining -= visit.darts.reduce((s, d) => s + d.score.points, 0);
    }
    // Subtract in-progress currentVisit darts for this player
    if (game.currentVisit && game.currentVisit.playerId === playerId) {
      remaining -= game.currentVisit.darts.reduce((s, d) => s + d.score.points, 0);
    }
    return Math.max(0, remaining);
  };

  const needsDoubleIn = game.settings.doubleIn && game.visits.filter(
    (v) => v.playerId === currentPlayer.id && !v.bust
  ).length === 0;

  // Detect bust / checkout state from currentVisit
  const visitState = (() => {
    const cv = game.currentVisit;
    if (!cv || !cv.locked) return 'active';
    const visitTotal = cv.darts.reduce((s, d) => s + d.score.points, 0);
    const remainingBefore = getRemaining(cv.playerId) + visitTotal;
    const after = remainingBefore - visitTotal;
    if (after < 0 || after === 1) return 'bust';
    if (after === 0) {
      if (!game.settings.doubleOut) return 'checkout';
      const last = cv.darts[cv.darts.length - 1];
      if (last.score.mult === 2 || last.score.label === 'DB') return 'checkout';
      return 'bust';
    }
    return 'full'; // 3 darts, no bust/checkout
  })();

  return (
    <div className="min-h-screen flex flex-col items-center p-4 gap-6">
      <h2 className="text-2xl font-bold text-green-400">
        {game.settings.startScore} — {game.settings.doubleOut ? 'Double Out' : 'Straight Out'}
        {isSpectator && <span className="text-yellow-400 text-base ml-2">(spectating)</span>}
      </h2>

      {/* Score panel */}
      <div className="flex gap-8">
        {game.players.map((p, i) => {
          const remaining = getRemaining(p.id);
          const isCurrent = i === game.currentPlayerIndex;
          const isBust = isCurrent && visitState === 'bust';
          const isCheckout = isCurrent && visitState === 'checkout';
          return (
            <div
              key={p.id}
              className={`text-center px-6 py-4 rounded-lg min-w-[120px] ${
                isCurrent ? 'bg-green-900 border border-green-500' : 'bg-gray-900'
              }`}
            >
              <p className="text-sm text-gray-400">{p.name}</p>
              {isBust ? (
                <p className="text-3xl font-bold text-red-400">Bust!</p>
              ) : isCheckout ? (
                <p className="text-3xl font-bold text-yellow-400">Checkout!</p>
              ) : (
                <p className={`text-4xl font-bold font-mono ${isCurrent ? 'text-green-400' : 'text-gray-300'}`}>
                  {remaining}
                </p>
              )}
              {isCurrent && game.status === 'in_progress' && (
                <p className="text-xs text-green-500 mt-1">▶ throwing</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Status bar */}
      {game.status === 'finished' && (
        <div className="text-center">
          <p className="text-2xl text-yellow-400 font-bold">
            🎯 {game.players.find((p) => p.id === game.winnerId)?.name ?? 'Unknown'} wins!
          </p>
        </div>
      )}

      {needsDoubleIn && isMyTurn && (
        <p className="text-yellow-400 font-semibold">Double-In required — hit a double to start scoring</p>
      )}

      {/* Dartboard / Visit Input */}
      {game.status === 'in_progress' && (
        <div className="w-full max-w-[500px]">
          <VisitInput
            darts={currentDarts}
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
        {[...game.visits].reverse().slice(0, 12).map((visit, i) => {
          const player = game.players.find((p) => p.id === visit.playerId);
          const labels = visit.darts.map((d) => d.score.label).join(' ');
          const total = visit.darts.reduce((s, d) => s + d.score.points, 0);
          return (
            <div
              key={visit.visitNumber}
              className={`flex justify-between py-1 px-2 text-sm ${
                visit.bust ? 'text-red-400' : 'text-gray-300'
              }`}
            >
              <span>{player?.name ?? '?'}</span>
              <span className="font-mono">
                {labels} = {visit.bust ? 'Bust' : total}
              </span>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <button
        onClick={onLeave}
        className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
      >
        {game.status === 'finished' ? 'Exit' : 'Leave Game'}
      </button>
    </div>
  );
}
