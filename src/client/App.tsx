import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router';
import { useEffect, useRef } from 'react';
import { useMatch } from './hooks/useMatch';
import { useScoringDevices } from './hooks/useScoringDevices';
import { useNavigationGuard } from './hooks/useNavigationGuard';
import { HomePage } from './pages/HomePage';
import { LobbyPage } from './pages/LobbyPage';
import { MatchScreen } from './pages/MatchScreen';
import { JoinHandler } from './pages/JoinHandler';
import { TopBar } from './components/TopBar';
import { loadReconnectInfo } from './lib/ws';
import type { ServerMessage } from '../shared/protocol';
import type { Lobby, MatchState, ModeView, RematchAnswer } from '../shared/types';

export function App() {
  // Scoring devices share the match socket, but the socket is created inside useMatch. The ref
  // is what lets the two be introduced without either owning the other.
  const devicesHandler = useRef<((msg: ServerMessage) => void) | null>(null);

  const {
    lobby,
    match,
    view,
    error,
    connected,
    ownPlayerId,
    isSpectator,
    sessionId,
    send,
    createLobby,
    joinLobby,
    addLocalPlayer,
    removePlayer,
    updateSettings,
    startMatch,
    submitVisit,
    leaveMatch,
    spectate,
    swapPlayers,
    voteRematch,
    addDart,
    undoDart,
  } = useMatch((msg) => devicesHandler.current?.(msg));

  const devices = useScoringDevices(send, connected);
  devicesHandler.current = devices.handleMessage;

  const navigate = useNavigate();

  // Navigate when lobby/match state arrives via WebSocket
  useEffect(() => {
    if (lobby && window.location.pathname === '/') {
      navigate(`/lobby/${lobby.id}`, { replace: true });
    }
  }, [lobby, navigate]);

  // Keyed on the match id, not merely on being somewhere under /match/: a re-match is a different
  // match, and leaving the old id in the URL would hand out a link to the wrong one. Spectators are
  // carried into a re-match too, and keep their own kind of link.
  useEffect(() => {
    if (!match || match.status !== 'in_progress') return;
    const path = isSpectator ? `/spectate/${match.id}` : `/match/${match.id}`;
    if (window.location.pathname !== path) navigate(path, { replace: true });
  }, [match, isSpectator, navigate]);

  // Navigate to home when lobby/match is abandoned (skip if page reload with reconnect info)
  useEffect(() => {
    if (!lobby && !match && window.location.pathname !== '/' && !window.location.pathname.startsWith('/lobby/join/')) {
      // Don't navigate away if we're about to reconnect after a page reload
      if (loadReconnectInfo()) return;
      navigate('/', { replace: true });
    }
  }, [lobby, match, navigate]);

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar
        connected={connected}
        devices={devices.devices}
        pairingCode={devices.pairingCode}
        onRequestPairingCode={devices.requestPairingCode}
        onCancelPairing={devices.cancelPairing}
        onGrab={devices.grab}
        onRelease={devices.release}
        onForget={devices.forget}
      />
      <main className="flex-1 flex flex-col">
      <Routes>
        <Route path="/" element={
          <HomePage
            onCreateLocalMatch={() => { createLobby(true); }}
            onCreateOnlineMatch={() => { createLobby(false); }}
            connected={connected}
          />
        } />

        <Route path="/lobby/join/:code" element={
          <JoinHandler onJoin={joinLobby} lobby={lobby} error={error} />
        } />

        <Route path="/lobby/:id" element={
          <LobbyWrapper
            lobby={lobby}
            ownPlayerId={ownPlayerId}
            isSpectator={isSpectator}
            sessionId={sessionId}
            startMatch={startMatch}
            leaveMatch={leaveMatch}
            updateSettings={updateSettings}
            addLocalPlayer={addLocalPlayer}
            removePlayer={removePlayer}
            swapPlayers={swapPlayers}
            navigate={navigate}
            error={error}
          />
        } />

        <Route path="/match/:id" element={
          <MatchWrapper
            match={match}
            view={view}
            ownPlayerId={ownPlayerId}
            isSpectator={isSpectator}
            leaveMatch={leaveMatch}
            addDart={addDart}
            undoDart={undoDart}
            submitVisit={submitVisit}
            onVoteRematch={voteRematch}
            sessionId={sessionId}
            navigate={navigate}
            error={error}
          />
        } />

        <Route path="/spectate/:id" element={
          <SpectateWrapper spectate={spectate} lobby={lobby} match={match} view={view} leaveMatch={leaveMatch} navigate={navigate} />
        } />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </main>
    </div>
  );
}

interface LobbyWrapperProps {
  lobby: Lobby | null;
  ownPlayerId: string | null;
  isSpectator: boolean;
  sessionId: string | null;
  startMatch: (lobbyId: string) => void;
  leaveMatch: (matchId: string) => void;
  updateSettings: (lobbyId: string, settings: any) => void;
  addLocalPlayer: (lobbyId: string, name: string) => void;
  removePlayer: (lobbyId: string, playerId: string) => void;
  swapPlayers: (lobbyId: string) => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  error: string | null;
}

function LobbyWrapper({ lobby, ownPlayerId, isSpectator, sessionId, startMatch, leaveMatch, updateSettings, addLocalPlayer, removePlayer, swapPlayers, navigate, error }: LobbyWrapperProps) {
  useNavigationGuard(lobby, error, navigate);

  if (!lobby) return <div className="flex-1 flex items-center justify-center text-gray-400">Loading lobby...</div>;
  return (
    <LobbyPage
      lobby={lobby}
      mode={lobby.isLocal ? 'local' : 'online'}
      isCreator={sessionId === lobby.hostSessionId || lobby.isLocal}
      ownPlayerId={ownPlayerId}
      isSpectator={isSpectator}
      sessionId={sessionId}
      onStartGame={() => startMatch(lobby.id)}
      onLeave={() => { leaveMatch(lobby.id); navigate('/'); }}
      onUpdateSettings={(s: any) => updateSettings(lobby.id, s)}
      onAddLocalPlayer={(n: string) => addLocalPlayer(lobby.id, n)}
      onRemovePlayer={(p: string) => removePlayer(lobby.id, p)}
      onSwapPlayers={() => swapPlayers(lobby.id)}
    />
  );
}

interface MatchWrapperProps {
  match: MatchState | null;
  view: ModeView | null;
  ownPlayerId: string | null;
  isSpectator: boolean;
  leaveMatch: (matchId: string) => void;
  addDart: (matchId: string, dart: any) => void;
  undoDart: (matchId: string) => void;
  submitVisit: (matchId: string) => void;
  onVoteRematch: (matchId: string, playerId: string, answer: RematchAnswer | 'neutral') => void;
  sessionId: string | null;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  error: string | null;
}

function MatchWrapper({ match, view, ownPlayerId, isSpectator, sessionId, leaveMatch, addDart, undoDart, submitVisit, onVoteRematch, navigate, error }: MatchWrapperProps) {
  useNavigationGuard(match, error, navigate);

  if (!match || !view) return <div className="flex-1 flex items-center justify-center text-gray-400">Loading match...</div>;
  return (
    <MatchScreen
      match={match}
      view={view}
      ownPlayerId={ownPlayerId}
      isSpectator={isSpectator}
      onLeave={() => { leaveMatch(match.id); navigate('/'); }}
      onAddDart={(gid: string, dart: any) => addDart(gid, dart)}
      onUndoDart={() => undoDart(match.id)}
      onSubmitVisit={() => submitVisit(match.id)}
      onVoteRematch={(playerId: string, answer: RematchAnswer | 'neutral') => onVoteRematch(match.id, playerId, answer)}
      sessionId={sessionId}
    />
  );
}

interface SpectateWrapperProps {
  spectate: (id: string) => void;
  lobby: Lobby | null;
  match: MatchState | null;
  view: ModeView | null;
  leaveMatch: (matchId: string) => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
}

function SpectateWrapper({ spectate, lobby, match, view, leaveMatch, navigate }: SpectateWrapperProps) {
  const { id } = useParams<{ id: string }>();

  useEffect(() => {
    if (id) spectate(id);
  }, [id]);

  const handleLeave = () => {
    leaveMatch(lobby?.id ?? match?.id ?? '');
    navigate('/');
  };

  if (lobby) {
    return (
      <LobbyPage
        lobby={lobby}
        mode={lobby.isLocal ? 'local' : 'online'}
        isCreator={false}
        ownPlayerId={null}
        isSpectator={true}
        sessionId={null}
        onStartGame={() => {}}
        onLeave={handleLeave}
        onUpdateSettings={() => {}}
        onAddLocalPlayer={() => {}}
        onRemovePlayer={() => {}}
        onSwapPlayers={() => {}}
      />
    );
  }

  if (match && view) {
    return (
      <MatchScreen
        match={match}
        view={view}
        ownPlayerId={null}
        isSpectator={true}
        onLeave={() => navigate('/')}
        onAddDart={() => {}}
        onUndoDart={() => {}}
        onSubmitVisit={() => {}}
        onVoteRematch={() => {}}
        sessionId={null}
      />
    );
  }

  return <div className="flex-1 flex items-center justify-center text-gray-400">Loading...</div>;
}
