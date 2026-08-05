import { useState, useCallback } from 'react';
import type { Lobby } from '../../shared/types';
import { storage } from '../lib/storage';

interface LobbyPageProps {
  lobby: Lobby;
  mode: 'local' | 'online';
  isCreator: boolean;
  ownPlayerId: string | null;
  isSpectator: boolean;
  onStartGame: () => void;
  onLeave: () => void;
  onUpdateSettings: (settings: any) => void;
  onAddLocalPlayer: (name: string) => void;
  onRemovePlayer: (playerId: string) => void;
}

export function LobbyPage({
  lobby,
  mode,
  isCreator,
  ownPlayerId,
  isSpectator,
  onStartGame,
  onLeave,
  onUpdateSettings,
  onAddLocalPlayer,
  onRemovePlayer,
}: LobbyPageProps) {
  const settings = lobby.settings;
  const [newName, setNewName] = useState('');
  const savedNames = storage.getPlayerNames();

  // Names already in the lobby (case-insensitive)
  const usedNames = new Set(lobby.players.map((p) => p.name.toLowerCase()));
  const availableNames = savedNames.filter((n) => !usedNames.has(n.toLowerCase()));

  // Online: each client can add 1 player, total max 2. Local: unlimited (but store caps at 2).
  const canAddLocal = mode === 'local' || lobby.players.length < 2;
  const canStart =
    mode === 'local'
      ? lobby.players.length >= 1
      : lobby.players.length === 2;
  // Online: only creator can edit settings
  const canEdit = !isSpectator && (mode === 'local' || isCreator);

  const isDuplicate = (name: string) => usedNames.has(name.trim().toLowerCase());

  const handleAdd = () => {
    const name = newName.trim();
    if (!name || isDuplicate(name)) return;
    storage.addPlayerName(name);
    onAddLocalPlayer(name);
    setNewName('');
  };

  const handleQuickAdd = (name: string) => {
    if (isDuplicate(name)) return;
    storage.addPlayerName(name);
    onAddLocalPlayer(name);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <h2 className="text-3xl font-bold text-green-400 mb-2">
        {mode === 'local' ? 'Local Match' : 'Online Match'}
        {isSpectator && <span className="text-yellow-400 text-lg ml-2">(spectating)</span>}
      </h2>
      <p className="text-gray-500 text-sm mb-6">
        {mode === 'local'
          ? 'Add players and configure the game'
          : 'Invite an opponent or wait for them to join'}
      </p>

      {/* Players */}
      <div className="w-80 mb-6">
        <h3 className="text-gray-400 text-sm uppercase mb-2">Players</h3>

        {/* Current players */}
        {lobby.players.map((p) => (
            <div key={p.id} className="flex items-center gap-2 py-2 border-b border-gray-800">
              <span className="flex-1 px-3 py-1 text-gray-200">{p.name}</span>
              {!isSpectator && (mode === 'local' || p.id === ownPlayerId) && (
                <button
                  onClick={() => onRemovePlayer(p.id)}
                  className="text-red-400 hover:text-red-300 text-sm px-1"
                  title="Remove player"
                >
                  ✕
                </button>
              )}
            </div>
        ))}

        {/* Add player section */}
        {!isSpectator && canAddLocal && (
          <div className="mt-3 space-y-2">
            {/* Quick-add from saved names */}
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

            {/* New name input */}
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

      {/* Game Settings */}
      <div className="w-80 mb-6">
        <h3 className="text-gray-400 text-sm uppercase mb-2">
          Settings
          {!canEdit && <span className="text-gray-600 ml-1">(read-only)</span>}
        </h3>
        <div className="space-y-3 bg-gray-900 rounded-lg p-4">
          <div>
            <label className="text-gray-400 text-sm">Starting Score</label>
            <select
              value={settings.startScore}
              onChange={(e) =>
                onUpdateSettings({ ...settings, startScore: Number(e.target.value) })
              }
              disabled={!canEdit}
              className="w-full mt-1 px-3 py-1 bg-gray-800 border border-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value={301}>301</option>
              <option value={501}>501</option>
              <option value={701}>701</option>
            </select>
          </div>

          <label className={`flex items-center gap-3 ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}>
            <input
              type="checkbox"
              checked={settings.doubleIn}
              onChange={(e) =>
                onUpdateSettings({ ...settings, doubleIn: e.target.checked })
              }
              disabled={!canEdit}
              className="w-4 h-4 accent-green-500 disabled:opacity-50"
            />
            <span className="text-gray-300">Double In</span>
          </label>

          <label className={`flex items-center gap-3 ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}>
            <input
              type="checkbox"
              checked={settings.doubleOut}
              onChange={(e) =>
                onUpdateSettings({ ...settings, doubleOut: e.target.checked })
              }
              disabled={!canEdit}
              className="w-4 h-4 accent-green-500 disabled:opacity-50"
            />
            <span className="text-gray-300">Double Out</span>
          </label>
        </div>
      </div>

      {/* Invite code (only creator of online lobby) */}
      {isCreator && mode === 'online' && lobby.inviteCode && (
        <div className="w-80 mb-6 text-center">
          <p className="text-gray-400 text-sm mb-2">Invite Code</p>
          <div className="flex items-center justify-center gap-2 mb-2">
            <code className="select-text text-2xl font-mono tracking-widest text-green-400 bg-gray-800 px-4 py-2 rounded">
              {lobby.inviteCode}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(lobby.inviteCode!)}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors"
              title="Copy to clipboard"
            >
              📋
            </button>
          </div>
          <p className="text-gray-500 text-xs">
            Or share:{' '}
            <a
              href={`/lobby/join/${lobby.inviteCode}`}
              className="text-blue-400 hover:underline select-text"
              onClick={(e) => {
                e.preventDefault();
                navigator.clipboard.writeText(
                  `${window.location.origin}/lobby/join/${lobby.inviteCode}`
                );
              }}
            >
              /lobby/join/{lobby.inviteCode}
            </a>
          </p>
        </div>
      )}

      {/* Waiting message (online only, not enough players) */}
      {mode === 'online' && lobby.players.length < 2 && (
        <p className="text-yellow-400 text-sm mb-6">
          {!ownPlayerId
            ? 'Add yourself as a player to get started'
            : 'Waiting for opponent to join...'}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-4">
        {!isSpectator && isCreator && (
          <button
            onClick={onStartGame}
            disabled={!canStart}
            className="px-6 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 rounded-lg font-semibold transition-colors"
          >
            Start Match
          </button>
        )}
        <button
          onClick={onLeave}
          className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
        >
          Leave
        </button>
      </div>
    </div>
  );
}
