import { useState } from 'react';
import { useNavigate } from 'react-router';

interface HomePageProps {
  onCreateLocalMatch: () => void;
  onCreateOnlineMatch: () => void;
  onJoinOnlineMatch: (code: string) => void;
  connected: boolean;
}

export function HomePage({
  onCreateLocalMatch,
  onCreateOnlineMatch,
  onJoinOnlineMatch,
  connected,
}: HomePageProps) {
  const [showJoin, setShowJoin] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const navigate = useNavigate();

  if (showJoin) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <h1 className="text-5xl font-bold text-green-400 mb-2">InstaDarts</h1>
        <p className="text-gray-500 mb-8">Join an online match</p>

        <div className="flex flex-col gap-4 w-64">
          <input
            type="text"
            placeholder="Invite code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-center text-xl tracking-widest focus:outline-none focus:border-green-500"
            maxLength={6}
            autoFocus
          />
          <button
            onClick={() => navigate(`/lobby/join/${joinCode.trim().toUpperCase()}`)}
            disabled={joinCode.length < 4 || !connected}
            className="px-6 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 rounded-lg font-semibold transition-colors"
          >
            Join Match
          </button>
          <button
            onClick={() => setShowJoin(false)}
            className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <h1 className="text-5xl font-bold text-green-400 mb-2">InstaDarts</h1>
      <p className="text-gray-500 mb-8">Dart game tracker</p>

      {!connected && (
        <p className="text-yellow-400 mb-4">Connecting to server...</p>
      )}

      <div className="flex flex-col gap-4 w-64">
        <button
          onClick={onCreateLocalMatch}
          disabled={!connected}
          className="px-6 py-4 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 rounded-lg font-semibold text-lg transition-colors"
        >
          Local Match
        </button>
        <button
          onClick={onCreateOnlineMatch}
          disabled={!connected}
          className="px-6 py-4 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 rounded-lg font-semibold text-lg transition-colors"
        >
          Create Online Match
        </button>
        <button
          onClick={() => setShowJoin(true)}
          disabled={!connected}
          className="px-6 py-4 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded-lg font-semibold text-lg transition-colors"
        >
          Join Online Match
        </button>
      </div>
    </div>
  );
}
