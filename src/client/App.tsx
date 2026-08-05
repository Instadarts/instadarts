import { useGameState } from './hooks/useGameState';
import { HomePage } from './pages/HomePage';
import { LobbyPage } from './pages/LobbyPage';
import { GamePage } from './pages/GamePage';

export function App() {
  const {
    lobby,
    game,
    connected,
    createLobby,
    joinLobby,
    updateSettings,
    setPlayerName,
    startGame,
    submitVisit,
    leaveGame,
  } = useGameState();

  if (lobby) {
    return (
      <LobbyPage
        lobby={lobby}
        onStartGame={() => startGame(lobby.id)}
        onLeave={() => leaveGame('')}
        onUpdateSettings={(settings) => updateSettings(lobby.id, settings)}
        onSetPlayerName={(playerId, name) => setPlayerName(lobby.id, playerId, name)}
        ownPlayerId={null}
      />
    );
  }

  if (game) {
    return (
      <GamePage
        game={game}
        onLeave={() => leaveGame(game.id)}
        onSubmitVisit={(visit) => submitVisit(game.id, visit)}
        ownPlayerId={null}
      />
    );
  }

  return (
    <HomePage
      onCreateLobby={createLobby}
      onJoinLobby={joinLobby}
      connected={connected}
    />
  );
}
