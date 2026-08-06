import { useEffect, useState } from 'react';
import type { PairingCode } from '../hooks/useScoringDevices';

interface PairDeviceDialogProps {
  code: PairingCode | null;
  onRequest: () => void;
  onCancel: () => void;
}

/**
 * The pairing code, and where to type it. The code is short because somebody reads it off one
 * screen and taps it into another; the link is there because that is faster when both are to hand.
 */
export function PairDeviceDialog({ code, onRequest, onCancel }: PairDeviceDialogProps) {
  const remaining = useCountdown(code?.expiresAt ?? null);
  const scorerUrl = `${window.location.origin}/scorer`;

  useEffect(() => {
    if (!code) onRequest();
  }, [code, onRequest]);

  if (!code) {
    return <p className="text-sm text-gray-400">Requesting a code…</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-gray-400">
        Open <span className="font-mono text-gray-200">{scorerUrl}</span> on the camera device and enter:
      </p>
      <p className="text-4xl font-mono font-bold tracking-[0.3em] text-green-400 text-center select-text">
        {code.code}
      </p>
      <div className="flex items-center justify-between text-sm">
        <span className={remaining > 0 ? 'text-gray-500' : 'text-yellow-400'}>
          {remaining > 0 ? `Expires in ${remaining}s` : 'Expired'}
        </span>
        <div className="flex gap-2">
          <button onClick={onRequest} className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded transition-colors">
            New code
          </button>
          <button onClick={onCancel} className="px-3 py-1 bg-gray-800 hover:bg-gray-700 rounded transition-colors">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** Seconds left, ticking. Zero once it has expired. */
function useCountdown(expiresAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (!expiresAt) return 0;
  return Math.max(0, Math.round((expiresAt - now) / 1000));
}
