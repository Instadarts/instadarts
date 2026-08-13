import { useEffect, useState } from 'react';
import type { PairingCode } from '../hooks/useScoringDevices';
import { QrCode } from './QrCode';
import { pairingUrl } from '../lib/pairingUrl';

interface PairDeviceDialogProps {
  code: PairingCode | null;
  onRequest: () => void;
  onCancel: () => void;
}

/**
 * The pairing code, as a thing to scan and as a thing to type.
 *
 * The QR is first because it is what the device being paired is best at: a camera phone is already
 * pointed at a screen and already has a scanner, and reading six characters off one screen to tap
 * into another is the slowest part of setting this up. The code stays, in full, for the phone whose
 * scanner will not open, or which is already on the scoring page.
 */
export function PairDeviceDialog({ code, onRequest, onCancel }: PairDeviceDialogProps) {
  const remaining = useCountdown(code?.expiresAt ?? null);
  const scorerUrl = `${window.location.origin}/scorer`;

  // Nothing is requested from here. Whoever opened this dialog asked for the code, because minting
  // one invalidates the session's previous one and an effect is not a promise that it runs once.
  if (!code) {
    return <p className="text-sm text-gray-400">Requesting a code…</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-gray-400">Scan this with the camera device:</p>
      <div className="flex justify-center">
        {/* Padded in white rather than sitting on the dark panel: the quiet zone the encoder draws
            is only a quiet zone if what surrounds it is the same colour as it. */}
        <div className="rounded-lg bg-white p-2">
          <QrCode text={pairingUrl(code.code)} size={180} />
        </div>
      </div>
      <p className="text-sm text-gray-400">
        Or open{' '}
        <span className="font-mono text-gray-200">{scorerUrl}</span>
        {' '}there and enter:
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
