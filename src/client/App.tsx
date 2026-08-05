import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router';
import { useEffect } from 'react';
import { useGameState } from './hooks/useGameState';
import { HomePage } from './pages/HomePage';
import { LobbyPage } from './pages/LobbyPage';
import { GamePage } from './pages/GamePage';
import { JoinHandler } from './pages/JoinHandler';

export function App() {
  const {
    lobby,
    game,
    connected,
    ownPlayerId,
    isSpectator,
    createLobby,
    joinLobby,
    addLocalPlayer,
    removePlayer,
    updateSettings,
    startGame,
    submitVisit,
    leaveGame,
    spectate,
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

  // Navigate to home when lobby is abandoned
  useEffect(() => {
    if (!lobby && !game && window.location.pathname !== '/' && !window.location.pathname.startsWith('/lobby/join/')) {
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
        <JoinHandler onJoin={joinLobby} lobby={lobby} />
      } />

      <Route path="/lobby/:id" element={
        <LobbyWrapper
          lobby={lobby}
          ownPlayerId={ownPlayerId}
          isSpectator={isSpectator}
          startGame={startGame}
          leaveGame={leaveGame}
          updateSettings={updateSettings}
          addLocalPlayer={addLocalPlayer}
          removePlayer={removePlayer}
          navigate={navigate}
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
        />
      } />

      <Route path="/spectate/:id" element={
        <SpectateWrapper spectate={spectate} lobby={lobby} game={game} navigate={navigate} />
      } />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function LobbyWrapper({ lobby, ownPlayerId, isSpectator, startGame, leaveGame, updateSettings, addLocalPlayer, removePlayer, navigate }: any) {
  if (!lobby) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading lobby...</div>;
  return (
    <LobbyPage
      lobby={lobby}
      mode={lobby.isLocal ? 'local' : 'online'}
      isCreator={ownPlayerId === lobby.hostPlayerId || lobby.isLocal}
      ownPlayerId={ownPlayerId}
      isSpectator={isSpectator}
      onStartGame={() => startGame(lobby.id)}
      onLeave={() => { leaveGame(lobby.id); navigate('/'); }}
      onUpdateSettings={(s: any) => updateSettings(lobby.id, s)}
      onAddLocalPlayer={(n: string) => addLocalPlayer(lobby.id, n)}
      onRemovePlayer={(p: string) => removePlayer(lobby.id, p)}
    />
  );
}

function MatchWrapper({ game, ownPlayerId, isSpectator, leaveGame, submitVisit, navigate }: any) {
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

function SpectateWrapper({ spectate, lobby, game, navigate }: any) {
  const { id } = useParams<{ id: string }>();

  useEffect(() => {
    if (id) spectate(id);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (lobby) {
    return (
      <LobbyPage
        lobby={lobby}
        mode={lobby.isLocal ? 'local' : 'online'}
        isCreator={false}
        ownPlayerId={null}
        isSpectator={true}
        onStartGame={() => {}}
        onLeave={() => navigate('/')}
        onUpdateSettings={() => {}}
        onAddLocalPlayer={() => {}}
        onRemovePlayer={() => {}}
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
