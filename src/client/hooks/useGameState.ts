import { useState, useCallback, useRef } from 'react';
import type { ServerMessage } from '../../shared/protocol';
import type { GameState, Lobby, Player } from '../../shared/types';
import { useWebSocket } from './useWebSocket';
import { saveReconnectInfo, clearReconnectInfo } from '../lib/ws';

/**
 * @param onServerMessage - Also called for every frame, before this hook handles it. Lets a second
 *   concern (scoring devices) share the one socket without this hook knowing anything about it.
 */
export function useGameState(onServerMessage?: (msg: ServerMessage) => void) {
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownPlayerId, setOwnPlayerId] = useState<string | null>(null);
  const [isSpectator, setIsSpectator] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Ref to always have the latest ownPlayerId (avoids stale closure in handleMessage)
  const ownPlayerIdRef = useRef<string | null>(null);
  ownPlayerIdRef.current = ownPlayerId;

  const extraHandlerRef = useRef(onServerMessage);
  extraHandlerRef.current = onServerMessage;

  const handleMessage = useCallback((msg: any) => {
    extraHandlerRef.current?.(msg);

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
          saveReconnectInfo({ lobbyId: msg.lobby.id, playerId: msg.yourPlayerId });
        } else if (msg.lobby.isLocal) {
          // Local lobby: save reconnect info (with or without players)
          const pid = msg.lobby.players.length > 0 ? msg.lobby.players[msg.lobby.players.length - 1].id : '';
          saveReconnectInfo({ lobbyId: msg.lobby.id, playerId: pid });
        }
        break;
      case 'game_state':
      case 'game_started':
        setGame(msg.game);
        setLobby(null);
        if (ownPlayerIdRef.current) {
          saveReconnectInfo({ gameId: msg.game.id, playerId: ownPlayerIdRef.current });
        } else if (msg.game.isLocal && msg.game.players.length > 0) {
          // Local game: save reconnect info with any player's ID
          saveReconnectInfo({ gameId: msg.game.id, playerId: msg.game.players[0].id });
        }
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

  const addDart = useCallback((gameId: string, dart: { x: number; y: number; score: any }) => {
    send({ type: 'add_dart', gameId, dart });
  }, [send]);

  const undoDart = useCallback((gameId: string) => {
    send({ type: 'undo_dart', gameId });
  }, [send]);

  const submitVisit = useCallback((gameId: string) => {
    send({ type: 'submit_visit', gameId });
    // Optimistically clear currentVisit so next player can throw immediately
    setGame((prev) => prev ? { ...prev, currentVisit: undefined } : prev);
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
    send,
    ownPlayerId,
    isSpectator,
    sessionId,
    createLobby,
    joinLobby,
    addLocalPlayer,
    removePlayer,
    updateSettings,
    startGame,
    addDart,
    undoDart,
    submitVisit,
    leaveGame,
    spectate,
    swapPlayers,
  };
}
