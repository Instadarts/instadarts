import { useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router';
import type { Lobby } from '../../shared/types';

interface JoinHandlerProps {
  onJoin: (code: string, playerName: string) => void;
  lobby: Lobby | null;
  error: string | null;
}

const JOIN_TIMEOUT_MS = 8000;

export function JoinHandler({ onJoin, lobby, error }: JoinHandlerProps) {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (code) {
      onJoin(code.toUpperCase(), '');
      // Safety timeout: if lobby never arrives, go home
      timerRef.current = setTimeout(() => {
        navigate('/', { replace: true });
      }, JOIN_TIMEOUT_MS);
    }
    return () => clearTimeout(timerRef.current);
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lobby) {
      clearTimeout(timerRef.current);
      navigate(`/lobby/${lobby.id}`, { replace: true });
    }
  }, [lobby, navigate]);

  // Server error (e.g. lobby not found, full) → go home
  useEffect(() => {
    if (error) {
      clearTimeout(timerRef.current);
      navigate('/', { replace: true });
    }
  }, [error, navigate]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-gray-400 gap-2">
      <p>Joining lobby...</p>
      {error && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
}
