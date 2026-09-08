import { useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Alert, Loader, Stack, Text } from '@mantine/core';
import type { Lobby, MatchState } from '../../shared/types';
import { ResponsiveBoxGrid } from '../layout/ResponsiveBoxGrid';
import { GridBox } from '../layout/GridBox';
import { JOIN_LAYOUTS } from '../layout/frontendLayout';

interface JoinHandlerProps {
  onJoin: (code: string) => void;
  lobby: Lobby | null;
  match: MatchState | null;
  error: string | null;
}

const JOIN_TIMEOUT_MS = 8000;

export function JoinHandler({ onJoin, lobby, match, error }: JoinHandlerProps) {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const initialLobby = useRef(lobby);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (code) {
      onJoin(code.toUpperCase());
      // Safety timeout: if lobby never arrives, go home
      timerRef.current = setTimeout(() => {
        navigate('/', { replace: true });
      }, JOIN_TIMEOUT_MS);
    }
    return () => clearTimeout(timerRef.current);
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (match) {
      clearTimeout(timerRef.current);
      return; // App navigates on match state, including an immediate automatic start.
    }
    if (lobby && lobby !== initialLobby.current) {
      clearTimeout(timerRef.current);
      navigate(`/lobby/${lobby.id}`, { replace: true });
    }
  }, [lobby, match, navigate]);

  // A refused invitation preserves an existing lobby; otherwise return home.
  useEffect(() => {
    if (error) {
      clearTimeout(timerRef.current);
      navigate(lobby ? `/lobby/${lobby.id}` : '/', { replace: true });
    }
  }, [error, lobby, navigate]);

  return (
    <ResponsiveBoxGrid
      defaultLayouts={JOIN_LAYOUTS}
      items={[{
        id: 'status',
        autoHeight: true,
        content: (
          <GridBox editable={false} centered>
            <Stack align="center" py="xl">
              <Loader color="green" />
              <Text c="dimmed">Joining lobby…</Text>
              {error && <Alert color="red">{error}</Alert>}
            </Stack>
          </GridBox>
        ),
      }]}
    />
  );
}
