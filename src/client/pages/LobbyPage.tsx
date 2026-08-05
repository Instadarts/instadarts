import type { Lobby } from '../../shared/types';

interface LobbyPageProps {
  lobby: Lobby;
  onStartGame: () => void;
  onLeave: () => void;
  onUpdateSettings: (settings: any) => void;
  onSetPlayerName: (playerId: string, name: string) => void;
  ownPlayerId: string | null;
}

export function LobbyPage({
  lobby,
  onStartGame,
  onLeave,
  onUpdateSettings,
  onSetPlayerName,
  ownPlayerId,
}: LobbyPageProps) {
  const settings = lobby.settings;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <h2 className="text-3xl font-bold text-green-400 mb-6">Game Lobby</h2>

      {/* Players */}
      <div className="w-80 mb-6">
        <h3 className="text-gray-400 text-sm uppercase mb-2">Players</h3>
        {lobby.players.map((p) => (
          <div key={p.id} className="flex items-center gap-2 py-2 border-b border-gray-800">
            <input
              type="text"
              value={p.name}
              onChange={(e) => onSetPlayerName(p.id, e.target.value)}
              className="flex-1 px-3 py-1 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-green-500"
              maxLength={20}
            />
            <span className="text-xs text-gray-500">{p.isRemote ? 'remote' : 'local'}</span>
          </div>
        ))}
        {lobby.players.length < 2 && (
          <p className="text-gray-600 text-sm mt-2">
            Waiting for opponent — share the invite code
          </p>
        )}
      </div>

      {/* Game Settings */}
      <div className="w-80 mb-6">
        <h3 className="text-gray-400 text-sm uppercase mb-2">Settings</h3>
        <div className="space-y-3 bg-gray-900 rounded-lg p-4">
          <div>
            <label className="text-gray-400 text-sm">Starting Score</label>
            <select
              value={settings.startScore}
              onChange={(e) => onUpdateSettings({ ...settings, startScore: Number(e.target.value) })}
              className="w-full mt-1 px-3 py-1 bg-gray-800 border border-gray-700 rounded"
            >
              <option value={301}>301</option>
              <option value={501}>501</option>
              <option value={701}>701</option>
            </select>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.doubleIn}
              onChange={(e) => onUpdateSettings({ ...settings, doubleIn: e.target.checked })}
              className="w-4 h-4 accent-green-500"
            />
            <span className="text-gray-300">Double In</span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.doubleOut}
              onChange={(e) => onUpdateSettings({ ...settings, doubleOut: e.target.checked })}
              className="w-4 h-4 accent-green-500"
            />
            <span className="text-gray-300">Double Out</span>
          </label>
        </div>
      </div>

      {/* Invite code */}
      {lobby.inviteCode && (
        <div className="w-80 mb-6 text-center">
          <p className="text-gray-400 text-sm">Invite Code</p>
          <p className="text-3xl font-mono tracking-widest text-green-400">{lobby.inviteCode}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-4">
        <button
          onClick={onStartGame}
          disabled={lobby.players.length < 1}
          className="px-6 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 rounded-lg font-semibold transition-colors"
        >
          Start Game
        </button>
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
