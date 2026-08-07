import { useState, useCallback, useRef } from 'react';
import type { ServerMessage } from '../../shared/protocol';
import type { MatchState, Lobby, ModeView } from '../../shared/types';
import { useWebSocket } from './useWebSocket';
import { saveReconnectInfo, clearReconnectInfo } from '../lib/ws';

/**
 * @param onServerMessage - Also called for every frame, before this hook handles it. Lets a second
 *   concern (scoring devices) share the one socket without this hook knowing anything about it.
 */
export function useMatch(onServerMessage?: (msg: ServerMessage) => void) {
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [match, setMatch] = useState<MatchState | null>(null);
  const [view, setView] = useState<ModeView | null>(null);
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
      case 'match_state':
      case 'match_started':
        setMatch(msg.match);
        setView(msg.view);
        setLobby(null);
        if (ownPlayerIdRef.current) {
          saveReconnectInfo({ matchId: msg.match.id, playerId: ownPlayerIdRef.current });
        } else if (msg.match.isLocal && msg.match.players.length > 0) {
          // Local match: save reconnect info with any player's ID
          saveReconnectInfo({ matchId: msg.match.id, playerId: msg.match.players[0].id });
        }
        break;
      case 'match_finished':
        setMatch(msg.match);
        setView(msg.view);
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

  const startMatch = useCallback((lobbyId: string) => {
    send({ type: 'start_match', lobbyId });
  }, [send]);

  const addDart = useCallback((matchId: string, dart: { x: number; y: number; score: any }) => {
    send({ type: 'add_dart', matchId, dart });
  }, [send]);

  const undoDart = useCallback((matchId: string) => {
    send({ type: 'undo_dart', matchId });
  }, [send]);

  // No optimistic clear: the view travels with the match state, and clearing the visit locally
  // would leave the mode's strings describing a visit that is no longer on screen. Every dart
  // already round-trips, so the reply that clears it arrives on the same path as the rest.
  const submitVisit = useCallback((matchId: string) => {
    send({ type: 'submit_visit', matchId });
  }, [send]);

  const leaveMatch = useCallback((matchId: string) => {
    send({ type: 'leave_match', matchId });
    setMatch(null);
    setView(null);
    setLobby(null);
    setOwnPlayerId(null);
    setIsSpectator(false);
    clearReconnectInfo();
  }, [send]);

  const spectate = useCallback((id: string) => {
    send({ type: 'spectate', id });
    setIsSpectator(true);
  }, [send]);

  const voteRematch = useCallback((matchId: string, playerId: string, accepted: boolean) => {
    send({ type: 'rematch_vote', matchId, playerId, accepted });
  }, [send]);

  const swapPlayers = useCallback((lobbyId: string) => {
    send({ type: 'swap_players', lobbyId });
  }, [send]);

  return {
    lobby,
    match,
    view,
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
    startMatch,
    addDart,
    undoDart,
    submitVisit,
    leaveMatch,
    spectate,
    swapPlayers,
    voteRematch,
  };
}
