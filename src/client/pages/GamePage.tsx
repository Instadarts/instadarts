import { useState, useCallback } from 'react';
import type { GameState, DartThrow } from '../../shared/types';
import { VisitInput } from '../components/VisitInput';

interface GamePageProps {
  game: GameState;
  onLeave: () => void;
  onSubmitVisit: (visit: { playerId: string; darts: DartThrow[]; bust: boolean }) => void;
  ownPlayerId: string | null;
}

export function GamePage({ game, onLeave, onSubmitVisit, ownPlayerId }: GamePageProps) {
  const [darts, setDarts] = useState<DartThrow[]>([]);

  const currentPlayer = game.players[game.currentPlayerIndex];
  // Local multiplayer (ownPlayerId is null): always allow input, server validates turn.
  // Online: only enable when it's this client's turn.
  const isMyTurn = game.status === 'in_progress' && (!ownPlayerId || currentPlayer.id === ownPlayerId);

  const getRemaining = useCallback((playerId: string): number => {
    let remaining = game.settings.startScore;
    for (const visit of game.visits) {
      if (visit.playerId !== playerId || visit.bust) continue;
      remaining -= visit.darts.reduce((s, d) => s + d.score.points, 0);
    }
    return Math.max(0, remaining);
  }, [game.visits, game.settings.startScore]);

  const handleAddDart = useCallback((dart: DartThrow) => {
    setDarts((prev) => [...prev, dart]);
  }, []);

  const handleUndo = useCallback(() => {
    setDarts((prev) => prev.slice(0, -1));
  }, []);

  const handleSubmit = useCallback(() => {
    const playerId = ownPlayerId ?? currentPlayer.id;
    onSubmitVisit({
      playerId,
      darts: [...darts],
      bust: false,
    });
    setDarts([]);
  }, [darts, ownPlayerId, currentPlayer.id, onSubmitVisit]);

  // Check for double-in requirement
  const needsDoubleIn = game.settings.doubleIn && game.visits.filter(
    (v) => v.playerId === currentPlayer.id && !v.bust
  ).length === 0;

  return (
    <div className="min-h-screen flex flex-col items-center p-4 gap-6">
      <h2 className="text-2xl font-bold text-green-400">
        {game.settings.startScore} — {game.settings.doubleOut ? 'Double Out' : 'Straight Out'}
      </h2>

      {/* Score panel */}
      <div className="flex gap-8">
        {game.players.map((p, i) => {
          const remaining = getRemaining(p.id);
          const isCurrent = i === game.currentPlayerIndex;
          return (
            <div
              key={p.id}
              className={`text-center px-6 py-4 rounded-lg min-w-[120px] ${
                isCurrent ? 'bg-green-900 border border-green-500' : 'bg-gray-900'
              }`}
            >
              <p className="text-sm text-gray-400">{p.name}</p>
              <p className={`text-4xl font-bold font-mono ${isCurrent ? 'text-green-400' : 'text-gray-300'}`}>
                {remaining}
              </p>
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

      {game.status === 'in_progress' && !isMyTurn && (
        <p className="text-gray-400 text-lg">{currentPlayer.name} is throwing...</p>
      )}

      {needsDoubleIn && isMyTurn && (
        <p className="text-yellow-400 font-semibold">Double-In required — hit a double to start scoring</p>
      )}

      {/* Dartboard / Visit Input */}
      {game.status === 'in_progress' && (
        <div className="w-full max-w-[500px]">
          <VisitInput
            darts={darts}
            onAddDart={handleAddDart}
            onUndoDart={handleUndo}
            onSubmit={handleSubmit}
            disabled={!isMyTurn}
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
              key={i}
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
