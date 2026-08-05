import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router';
import { useEffect, useRef } from 'react';
import { useGameState } from './hooks/useGameState';
import { HomePage } from './pages/HomePage';
import { LobbyPage } from './pages/LobbyPage';
import { GamePage } from './pages/GamePage';
import { JoinHandler } from './pages/JoinHandler';
import { loadReconnectInfo } from './lib/ws';

export function App() {
  const {
    lobby,
    game,
    error,
    connected,
    ownPlayerId,
    isSpectator,
    sessionId,
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
  } = useGameState();

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
    <Routes>
      <Route path="/" element={
        <HomePage
          onCreateLocalMatch={() => { createLobby(true); }}
          onCreateOnlineMatch={() => { createLobby(false); }}
          onJoinOnlineMatch={(code) => navigate(`/lobby/join/${code}`)}
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
  );
}

function LobbyWrapper({ lobby, ownPlayerId, isSpectator, sessionId, startGame, leaveGame, updateSettings, addLocalPlayer, removePlayer, swapPlayers, navigate, error }: any) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (navigatedRef.current) return;
    if (lobby) {
      clearTimeout(timerRef.current);
      return;
    }
    if (error) {
      clearTimeout(timerRef.current);
      navigatedRef.current = true;
      navigate('/', { replace: true });
      return;
    }
    timerRef.current = setTimeout(() => {
      if (!navigatedRef.current) {
        navigatedRef.current = true;
        navigate('/', { replace: true });
      }
    }, 8000);
    return () => clearTimeout(timerRef.current);
  }, [lobby, error]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!lobby) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading lobby...</div>;
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

function MatchWrapper({ game, ownPlayerId, isSpectator, leaveGame, submitVisit, navigate, error }: any) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (navigatedRef.current) return;
    if (game) {
      clearTimeout(timerRef.current);
      return;
    }
    if (error) {
      clearTimeout(timerRef.current);
      navigatedRef.current = true;
      navigate('/', { replace: true });
      return;
    }
    timerRef.current = setTimeout(() => {
      if (!navigatedRef.current) {
        navigatedRef.current = true;
        navigate('/', { replace: true });
      }
    }, 8000);
    return () => clearTimeout(timerRef.current);
  }, [game, error]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!game) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading game...</div>;
  return (
    <GamePage
      game={game}
      ownPlayerId={ownPlayerId}
      isSpectator={isSpectator}
      onLeave={() => { leaveGame(game.id); navigate('/'); }}
      onSubmitVisit={(v: any) => submitVisit(game.id, v)}
    />
  );
}

function SpectateWrapper({ spectate, lobby, game, leaveGame, navigate }: any) {
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
        onSubmitVisit={() => {}}
      />
    );
  }

  return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading...</div>;
}
