import { useState, useCallback } from 'react';
import { useGameState } from './hooks/useGameState';
import { HomePage } from './pages/HomePage';
import { LobbyPage } from './pages/LobbyPage';
import { GamePage } from './pages/GamePage';
import { storage } from './lib/storage';

type LobbyMode = 'local' | 'online';

export function App() {
  const {
    lobby,
    game,
    connected,
    ownPlayerId,
    createLobby,
    joinLobby,
    addLocalPlayer,
    removePlayer,
    updateSettings,
    setPlayerName,
    startGame,
    submitVisit,
    leaveGame,
  } = useGameState();

  const [lobbyMode, setLobbyMode] = useState<LobbyMode | null>(null);

  // Home page handlers
  const handleCreateLocalMatch = useCallback(() => {
    createLobby();
    setLobbyMode('local');
  }, [createLobby]);

  const handleCreateOnlineMatch = useCallback(() => {
    createLobby();
    setLobbyMode('online');
  }, [createLobby]);

  const handleJoinOnlineMatch = useCallback((code: string) => {
    const name = storage.getPlayerNames()[0] ?? 'Player 1';
    joinLobby(code, name);
    setLobbyMode('online');
  }, [joinLobby]);

  const handleLeave = useCallback(() => {
    leaveGame(lobby?.id ?? game?.id ?? '');
    setLobbyMode(null);
  }, [leaveGame, lobby, game]);

  // Lobby
  if (lobby && lobbyMode) {
    return (
      <LobbyPage
        lobby={lobby}
        mode={lobbyMode}
        onStartGame={() => startGame(lobby.id)}
        onLeave={handleLeave}
        onUpdateSettings={(settings) => updateSettings(lobby.id, settings)}
        onSetPlayerName={(playerId, name) => setPlayerName(lobby.id, playerId, name)}
        onAddLocalPlayer={(name) => addLocalPlayer(lobby.id, name)}
        onRemovePlayer={(playerId) => removePlayer(lobby.id, playerId)}
      />
    );
  }

  // Game
  if (game) {
    return (
      <GamePage
        game={game}
        onLeave={handleLeave}
        onSubmitVisit={(visit) => submitVisit(game.id, visit)}
        ownPlayerId={ownPlayerId}
      />
    );
  }

  // Home
  return (
    <HomePage
      onCreateLocalMatch={handleCreateLocalMatch}
      onCreateOnlineMatch={handleCreateOnlineMatch}
      onJoinOnlineMatch={handleJoinOnlineMatch}
      connected={connected}
    />
  );
}
