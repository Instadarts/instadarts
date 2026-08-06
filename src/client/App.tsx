import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router';
import { useEffect, useRef } from 'react';
import { useGameState } from './hooks/useGameState';
import { useScoringDevices } from './hooks/useScoringDevices';
import { useNavigationGuard } from './hooks/useNavigationGuard';
import { HomePage } from './pages/HomePage';
import { LobbyPage } from './pages/LobbyPage';
import { GamePage } from './pages/GamePage';
import { JoinHandler } from './pages/JoinHandler';
import { TopBar } from './components/TopBar';
import { loadReconnectInfo } from './lib/ws';
import type { ServerMessage } from '../shared/protocol';
import type { Lobby, GameState } from '../shared/types';

export function App() {
  // Scoring devices share the match socket, but the socket is created inside useGameState. The ref
  // is what lets the two be introduced without either owning the other.
  const devicesHandler = useRef<((msg: ServerMessage) => void) | null>(null);

  const {
    lobby,
    game,
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
    startGame,
    submitVisit,
    leaveGame,
    spectate,
    swapPlayers,
    addDart,
    undoDart,
  } = useGameState((msg) => devicesHandler.current?.(msg));

  const devices = useScoringDevices(send, connected);
  devicesHandler.current = devices.handleMessage;

  const navigate = useNavigate();

  // Navigate when lobby/game state arrives via WebSocket
  useEffect(() => {
    if (lobby && window.location.pathname === '/') {
      navigate(`/lobby/${lobby.id}`, { replace: true });
    }
  }, [lobby, navigate]);

  useEffect(() => {
    if (game && game.status === 'in_progress' && !window.location.pathname.startsWith('/match/')) {
      navigate(`/match/${game.id}`, { replace: true });
    }
  }, [game, navigate]);

  // Navigate to home when lobby/game is abandoned (skip if page reload with reconnect info)
  useEffect(() => {
    if (!lobby && !game && window.location.pathname !== '/' && !window.location.pathname.startsWith('/lobby/join/')) {
      // Don't navigate away if we're about to reconnect after a page reload
      if (loadReconnectInfo()) return;
      navigate('/', { replace: true });
    }
  }, [lobby, game, navigate]);

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
            startGame={startGame}
            leaveGame={leaveGame}
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
            game={game}
            ownPlayerId={ownPlayerId}
            isSpectator={isSpectator}
            leaveGame={leaveGame}
            addDart={addDart}
            undoDart={undoDart}
            submitVisit={submitVisit}
            navigate={navigate}
            error={error}
          />
        } />

        <Route path="/spectate/:id" element={
          <SpectateWrapper spectate={spectate} lobby={lobby} game={game} leaveGame={leaveGame} navigate={navigate} />
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
  startGame: (lobbyId: string) => void;
  leaveGame: (gameId: string) => void;
  updateSettings: (lobbyId: string, settings: any) => void;
  addLocalPlayer: (lobbyId: string, name: string) => void;
  removePlayer: (lobbyId: string, playerId: string) => void;
  swapPlayers: (lobbyId: string) => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  error: string | null;
}

function LobbyWrapper({ lobby, ownPlayerId, isSpectator, sessionId, startGame, leaveGame, updateSettings, addLocalPlayer, removePlayer, swapPlayers, navigate, error }: LobbyWrapperProps) {
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
      onStartGame={() => startGame(lobby.id)}
      onLeave={() => { leaveGame(lobby.id); navigate('/'); }}
      onUpdateSettings={(s: any) => updateSettings(lobby.id, s)}
      onAddLocalPlayer={(n: string) => addLocalPlayer(lobby.id, n)}
      onRemovePlayer={(p: string) => removePlayer(lobby.id, p)}
      onSwapPlayers={() => swapPlayers(lobby.id)}
    />
  );
}

interface MatchWrapperProps {
  game: GameState | null;
  ownPlayerId: string | null;
  isSpectator: boolean;
  leaveGame: (gameId: string) => void;
  addDart: (gameId: string, dart: any) => void;
  undoDart: (gameId: string) => void;
  submitVisit: (gameId: string) => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  error: string | null;
}

function MatchWrapper({ game, ownPlayerId, isSpectator, leaveGame, addDart, undoDart, submitVisit, navigate, error }: MatchWrapperProps) {
  useNavigationGuard(game, error, navigate);

  if (!game) return <div className="flex-1 flex items-center justify-center text-gray-400">Loading game...</div>;
  return (
    <GamePage
      game={game}
      ownPlayerId={ownPlayerId}
      isSpectator={isSpectator}
      onLeave={() => { leaveGame(game.id); navigate('/'); }}
      onAddDart={(gid: string, dart: any) => addDart(gid, dart)}
      onUndoDart={() => undoDart(game.id)}
      onSubmitVisit={() => submitVisit(game.id)}
    />
  );
}

interface SpectateWrapperProps {
  spectate: (id: string) => void;
  lobby: Lobby | null;
  game: GameState | null;
  leaveGame: (gameId: string) => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
}

function SpectateWrapper({ spectate, lobby, game, leaveGame, navigate }: SpectateWrapperProps) {
  const { id } = useParams<{ id: string }>();

  useEffect(() => {
    if (id) spectate(id);
  }, [id]);

  const handleLeave = () => {
    leaveGame(lobby?.id ?? game?.id ?? '');
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

  if (game) {
    return (
      <GamePage
        game={game}
        ownPlayerId={null}
        isSpectator={true}
        onLeave={() => navigate('/')}
        onAddDart={() => {}}
        onUndoDart={() => {}}
        onSubmitVisit={() => {}}
      />
    );
  }

  return <div className="flex-1 flex items-center justify-center text-gray-400">Loading...</div>;
}
