import { useState } from 'react';
import { storage } from '../lib/storage';
import type { Player } from '../../shared/types';

interface PlayerListProps {
  players: Player[];
  mode: 'local' | 'online';
  isCreator: boolean;
  isSpectator: boolean;
  /** This user's own player, in an online lobby. A local lobby's players are all theirs. */
  ownPlayerId: string | null;
  onAdd: (name: string) => void;
  onRemove: (playerId: string) => void;
  onSwap: () => void;
}

export function PlayerList({ players, mode, isCreator, isSpectator, ownPlayerId, onAdd, onRemove, onSwap }: PlayerListProps) {
  const [newName, setNewName] = useState('');
  const savedNames = storage.getPlayerNames();
  const usedNames = new Set(players.map((p) => p.name.toLowerCase()));
  const availableNames = savedNames.filter((n) => !usedNames.has(n.toLowerCase()));

  const canAddLocal = mode === 'local'
    ? players.length < 2
    : players.length < 2 && !ownPlayerId;

  const isDuplicate = (name: string) => usedNames.has(name.trim().toLowerCase());

  const handleAdd = () => {
    const name = newName.trim();
    if (!name || isDuplicate(name)) return;
    storage.addPlayerName(name);
    onAdd(name);
    setNewName('');
  };

  const handleQuickAdd = (name: string) => {
    if (isDuplicate(name)) return;
    storage.addPlayerName(name);
    onAdd(name);
  };

  return (
    <div className="w-80 mb-6">
      <h3 className="text-gray-400 text-sm uppercase mb-2">Players</h3>

      {players.map((p, i) => (
        <div key={p.id} className="flex items-center gap-2 py-2 border-b border-gray-800">
          <span className="text-gray-500 text-xs w-6">{i === 0 ? '1st' : '2nd'}</span>
          <span className="flex-1 px-3 py-1 text-gray-200">{p.name}</span>
          {!isSpectator && (mode === 'local' || p.id === ownPlayerId) && (
            <button
              onClick={() => onRemove(p.id)}
              className="text-red-400 hover:text-red-300 text-sm px-1"
              title="Remove player"
            >
              ✕
            </button>
          )}
        </div>
      ))}

      {!isSpectator && isCreator && players.length === 2 && (
        <div className="mt-2 text-center">
          <button
            onClick={onSwap}
            className="px-3 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs text-gray-400 hover:text-gray-200 transition-colors"
            title="Swap player order"
          >
            ⇅ Swap order
          </button>
        </div>
      )}

      {!isSpectator && canAddLocal && (
        <div className="mt-3 space-y-2">
          {availableNames.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {availableNames.map((name) => (
                <button
                  key={name}
                  onClick={() => handleQuickAdd(name)}
                  className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-full text-xs text-gray-300 transition-colors"
                >
                  + {name}
                </button>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              placeholder="New player name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm focus:outline-none focus:border-blue-500"
              maxLength={20}
            />
            <button
              onClick={handleAdd}
              disabled={!newName.trim() || isDuplicate(newName)}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 rounded text-sm font-semibold transition-colors"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
