import { useEffect, useState } from 'react';

interface JoinViewProps {
  onPair: (code: string) => void;
  pairing: boolean;
  badCode: boolean;
  /** The server has no room for another scoring device right now. Nothing to do but wait. */
  serverFull: boolean;
  connected: boolean;
}

const CODE_LENGTH = 6;

/**
 * Where a phone joins a browser. The code is auto-submitted from `?pair=CODE`, because the usual
 * way to get here is following a link from the screen that is showing the code.
 */
export function JoinView({ onPair, pairing, badCode, serverFull, connected }: JoinViewProps) {
  const [code, setCode] = useState('');

  useEffect(() => {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('pair');
    if (!fromUrl) return;

    setCode(fromUrl.toUpperCase().slice(0, CODE_LENGTH));
    // Spent once it has been offered. A code is single-use, so leaving it in the address bar only
    // means the next visit here — after a reload, or after unpairing — starts with a dead one
    // filled in.
    url.searchParams.delete('pair');
    window.history.replaceState(null, '', url);
  }, []);

  const ready = code.length === CODE_LENGTH && connected && !pairing;

  const submit = () => {
    if (ready) onPair(code);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 gap-5">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-green-400">Scoring device</h1>
        <p className="text-gray-500 mt-1">Point this camera at your board.</p>
      </div>

      <p className="text-gray-400 text-sm text-center max-w-xs">
        In InstaDarts on your other device, open the top bar and choose <em>Pair scoring device</em>.
      </p>

      <input
        type="text"
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH))}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="CODE"
        className="w-56 px-4 py-3 text-center text-3xl font-mono tracking-[0.3em] bg-gray-900 border border-gray-700 rounded-lg focus:border-green-500 focus:outline-none"
      />

      {badCode && <p className="text-red-400 text-sm">That code was not accepted. Ask for a new one.</p>}
      {serverFull && <p className="text-yellow-400 text-sm">The server is full. Try again in a moment.</p>}
      {!connected && <p className="text-yellow-400 text-sm">Connecting to server…</p>}

      <button
        onClick={submit}
        disabled={!ready}
        className="px-8 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 rounded-lg font-semibold transition-colors"
      >
        {pairing ? 'Pairing…' : 'Pair'}
      </button>
    </div>
  );
}
