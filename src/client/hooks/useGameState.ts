import { useState, useCallback, useRef } from 'react';
import type { ServerMessage } from '../../shared/protocol';
import type { GameState, Lobby, Player } from '../../shared/types';
import { useWebSocket } from './useWebSocket';
import { saveReconnectInfo, clearReconnectInfo } from '../lib/ws';

export function useGameState() {
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownPlayerId, setOwnPlayerId] = useState<string | null>(null);
  const [isSpectator, setIsSpectator] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Ref to always have the latest ownPlayerId (avoids stale closure in handleMessage)
  const ownPlayerIdRef = useRef<string | null>(null);
  ownPlayerIdRef.current = ownPlayerId;

  const handleMessage = useCallback((msg: any) => {
    // Handle connected message (not a ServerMessage type)
    if (msg.type === 'connected' && msg.sessionId) {
      setSessionId(msg.sessionId);
      return;
    }

    switch (msg.type) {
      case 'lobby_state':
        setLobby(msg.lobby);
        if (msg.yourPlayerId) {
          setOwnPlayerId(msg.yourPlayerId);
          // Persist for page reload recovery
          saveReconnectInfo({ lobbyId: msg.lobby.id, playerId: msg.yourPlayerId });
        }
        break;
      case 'game_state':
      case 'game_started':
        setGame(msg.game);
        setLobby(null);
        saveReconnectInfo({ gameId: msg.game.id, playerId: ownPlayerIdRef.current ?? 'unknown' });
        break;
      case 'game_finished':
        setGame(msg.game);
        clearReconnectInfo();
        break;
      case 'lobby_abandoned':
        setLobby(null);
        setOwnPlayerId(null);
        setIsSpectator(false);
        clearReconnectInfo();
        break;
      case 'error':
        setError(msg.message);
        break;
      case 'player_joined':
        // Handled by lobby_state broadcast
        break;
      case 'player_left':
        // Handled by lobby_state broadcast
        break;
    }
  }, []);

  const { send, connected } = useWebSocket(handleMessage);

  const createLobby = useCallback((isLocal = true) => {
    send({ type: 'create_lobby', isLocal });
    setError(null);
  }, [send]);

  const joinLobby = useCallback((inviteCode: string, playerName: string) => {
    send({ type: 'join_lobby', inviteCode, playerName });
    setError(null);
  }, [send]);

  const addLocalPlayer = useCallback((lobbyId: string, playerName: string) => {
    send({ type: 'add_local_player', lobbyId, playerName });
  }, [send]);

  const removePlayer = useCallback((lobbyId: string, playerId: string) => {
    send({ type: 'remove_player', lobbyId, playerId });
  }, [send]);

  const updateSettings = useCallback((lobbyId: string, settings: any) => {
    send({ type: 'update_settings', lobbyId, settings });
  }, [send]);

  const setPlayerName = useCallback((lobbyId: string, playerId: string, name: string) => {
    send({ type: 'set_player_name', lobbyId, playerId, name });
  }, [send]);

  const startGame = useCallback((lobbyId: string) => {
    send({ type: 'start_game', lobbyId });
  }, [send]);

  const submitVisit = useCallback((gameId: string, visit: any) => {
    send({ type: 'submit_visit', gameId, visit });
  }, [send]);

  const leaveGame = useCallback((gameId: string) => {
    send({ type: 'leave_game', gameId });
    setGame(null);
    setLobby(null);
    setOwnPlayerId(null);
    setIsSpectator(false);
    clearReconnectInfo();
  }, [send]);

  const spectate = useCallback((id: string) => {
    send({ type: 'spectate', id });
    setIsSpectator(true);
  }, [send]);

  const swapPlayers = useCallback((lobbyId: string) => {
    send({ type: 'swap_players', lobbyId });
  }, [send]);

  return {
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
    setPlayerName,
    startGame,
    submitVisit,
    leaveGame,
    spectate,
    swapPlayers,
  };
}
