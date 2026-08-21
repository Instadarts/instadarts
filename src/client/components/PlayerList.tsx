import { useState } from 'react';
import { storage } from '../lib/storage';
import type { Player } from '../../shared/types';

interface PlayerListProps {
  players: Player[];
  maxPlayers: number;
  isCreator: boolean;
  isSpectator: boolean;
  /** This user's own players — every one of them, in a lobby nobody else joined. */
  ownPlayerIds: string[];
  onAdd: (name: string) => void;
  onRemove: (playerId: string) => void;
  onReorder?: (playerId: string, direction: 'up' | 'down') => void;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function PlayerList({
  players,
  maxPlayers,
  isCreator,
  isSpectator,
  ownPlayerIds,
  onAdd,
  onRemove,
  onReorder,
}: PlayerListProps) {
  const [newName, setNewName] = useState('');
  const savedNames = storage.getPlayerNames();
  const usedNames = new Set(players.map((p) => p.name.toLowerCase()));
  const availableNames = savedNames.filter((n) => !usedNames.has(n.toLowerCase()));

  const canAdd = players.length < maxPlayers;
  /** Whether a player is this user's own. In a lobby nobody joined, that is all of them. */
  const isMine = (playerId: string) => ownPlayerIds.includes(playerId);
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
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-gray-400 text-sm uppercase">Players</h3>
        <span className="text-xs text-gray-500">
          {players.length >= maxPlayers ? `Full — ${maxPlayers} max` : `${players.length}/${maxPlayers}`}
        </span>
      </div>

      {players.map((p, i) => (
        <div key={p.id} className="flex items-center gap-2 py-2 border-b border-gray-800">
          <span className="text-gray-500 text-xs w-7">{ordinal(i + 1)}</span>
          <span className="flex-1 px-2 py-1 text-gray-200 truncate">{p.name}</span>

          {!isSpectator && isCreator && onReorder && players.length >= 2 && (
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => onReorder(p.id, 'up')}
                disabled={i === 0}
                className="text-gray-400 hover:text-gray-200 disabled:opacity-20 text-xs px-1 py-0.5 rounded hover:bg-gray-800"
                title="Move up"
              >
                ▲
              </button>
              <button
                onClick={() => onReorder(p.id, 'down')}
                disabled={i === players.length - 1}
                className="text-gray-400 hover:text-gray-200 disabled:opacity-20 text-xs px-1 py-0.5 rounded hover:bg-gray-800"
                title="Move down"
              >
                ▼
              </button>
            </div>
          )}

          {!isSpectator && (isMine(p.id) || isCreator) && (
            <button
              onClick={() => onRemove(p.id)}
              className="text-red-400 hover:text-red-300 text-sm px-1 ml-1"
              /* Taking somebody else's player off the roster is a kick, not tidying your own
                 list, and the two should not read the same. */
              title={isMine(p.id) ? 'Remove player' : 'Kick player'}
            >
              ✕
            </button>
          )}
        </div>
      ))}

      {!isSpectator && canAdd && (
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
