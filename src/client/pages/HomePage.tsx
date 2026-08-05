import { useState } from 'react';
import { storage } from '../lib/storage';

interface HomePageProps {
  onCreateLobby: (name: string) => void;
  onJoinLobby: (code: string, name: string) => void;
  connected: boolean;
}

export function HomePage({ onCreateLobby, onJoinLobby, connected }: HomePageProps) {
  const [playerName, setPlayerName] = useState(storage.getPlayerName() ?? '');
  const [joinCode, setJoinCode] = useState('');
  const [mode, setMode] = useState<'idle' | 'create' | 'join'>('idle');

  const handleCreate = () => {
    const name = playerName.trim() || 'Player 1';
    storage.setPlayerName(name);
    onCreateLobby(name);
  };

  const handleJoin = () => {
    const name = playerName.trim() || 'Player 2';
    storage.setPlayerName(name);
    onJoinLobby(joinCode.trim().toUpperCase(), name);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <h1 className="text-5xl font-bold text-green-400 mb-2">InstaDarts</h1>
      <p className="text-gray-500 mb-8">Dart game tracker</p>

      {!connected && (
        <p className="text-yellow-400 mb-4">Connecting to server...</p>
      )}

      {mode === 'idle' && (
        <div className="flex flex-col gap-4 w-64">
          <input
            type="text"
            placeholder="Your name"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-center focus:outline-none focus:border-green-500"
            maxLength={20}
          />
          <button
            onClick={() => setMode('create')}
            disabled={!connected}
            className="px-6 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 rounded-lg font-semibold transition-colors"
          >
            New Game
          </button>
          <button
            onClick={() => setMode('join')}
            disabled={!connected}
            className="px-6 py-3 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded-lg font-semibold transition-colors"
          >
            Join Game
          </button>
        </div>
      )}

      {mode === 'create' && (
        <div className="flex flex-col gap-4 w-64">
          <p className="text-center text-gray-400">Create a new game as</p>
          <p className="text-center text-xl text-white">{playerName || 'Player 1'}</p>
          <button
            onClick={handleCreate}
            className="px-6 py-3 bg-green-600 hover:bg-green-500 rounded-lg font-semibold transition-colors"
          >
            Create Lobby
          </button>
          <button
            onClick={() => setMode('idle')}
            className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
          >
            Back
          </button>
        </div>
      )}

      {mode === 'join' && (
        <div className="flex flex-col gap-4 w-64">
          <input
            type="text"
            placeholder="Invite code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-center text-xl tracking-widest focus:outline-none focus:border-green-500"
            maxLength={6}
          />
          <button
            onClick={handleJoin}
            disabled={joinCode.length < 4 || !connected}
            className="px-6 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 rounded-lg font-semibold transition-colors"
          >
            Join Lobby
          </button>
          <button
            onClick={() => setMode('idle')}
            className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
          >
            Back
          </button>
        </div>
      )}
    </div>
  );
}
