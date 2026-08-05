import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import type { Lobby } from '../../shared/types';

interface JoinHandlerProps {
  onJoin: (code: string, playerName: string) => void;
  lobby: Lobby | null;
}

export function JoinHandler({ onJoin, lobby }: JoinHandlerProps) {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    if (code) {
      onJoin(code.toUpperCase(), '');
    }
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lobby) {
      navigate(`/lobby/${lobby.id}`, { replace: true });
    }
  }, [lobby, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center text-gray-400">
      Joining lobby...
    </div>
  );
}
