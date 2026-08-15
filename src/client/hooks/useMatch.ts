import { useState, useCallback, useRef } from 'react';
import type { ServerMessage } from '../../shared/protocol';
import type { MatchState, Lobby, ModePanel, ModeView, Player, RematchAnswer } from '../../shared/types';
import type { ModeDescriptor } from '../../shared/settings';
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
  const [panel, setPanel] = useState<ModePanel | undefined>(undefined);
  /** What this deployment can play. Sent once on connect; the lobby is built from it. */
  const [modes, setModes] = useState<ModeDescriptor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ownPlayerId, setOwnPlayerId] = useState<string | null>(null);
  const [isSpectator, setIsSpectator] = useState(false);
  /** Whether this user created the lobby it is in. The server's answer, not a comparison we make. */
  const [isHost, setIsHost] = useState(false);
  /**
   * Something that happened *to* this tab and has to be explained on the screen it lands on — as
   * opposed to `error`, which answers a request this tab made.
   */
  const [notice, setNotice] = useState<string | null>(null);
  /** Advances after a spectator request so media_join is ordered behind it on that socket. */
  const [roomGeneration, setRoomGeneration] = useState(0);

  const extraHandlerRef = useRef(onServerMessage);
  extraHandlerRef.current = onServerMessage;

  const handleMessage = useCallback((msg: any) => {
    extraHandlerRef.current?.(msg);

    switch (msg.type) {
      // What to present if this tab is loaded again. The server sends it only to a connection that
      // holds a place in the room, which is what keeps a spectator's tab from storing a claim on a
      // player it is merely watching.
      case 'resume':
        saveReconnectInfo({ lobbyId: msg.lobbyId, matchId: msg.matchId, token: msg.token });
        break;
      case 'lobby_state':
        setLobby(msg.lobby);
        // Only a message addressed to this connection names its player; a broadcast names nobody's.
        // So "mine is gone" cannot be said by the absence of the field — it is the player itself no
        // longer being in the lobby, which is what removing your own player looks like from here.
        if (msg.yourPlayerId) setOwnPlayerId(msg.yourPlayerId);
        else setOwnPlayerId((mine) => (mine && msg.lobby.players.some((p: Player) => p.id === mine) ? mine : null));
        // Addressed either way — `false` is as much an answer as `true`, and only a broadcast leaves
        // the question alone.
        if (msg.youAreHost !== undefined) setIsHost(msg.youAreHost);
        break;
      case 'mode_catalog':
        setModes(msg.modes);
        break;
      case 'match_state':
      case 'match_started':
        setMatch(msg.match);
        setView(msg.view);
        setPanel(msg.panel);
        setLobby(null);
        // Only a reply to this connection carries one, and it is how a reloaded tab learns which
        // player is its own — the match itself no longer says who anybody belongs to.
        if (msg.yourPlayerId) setOwnPlayerId(msg.yourPlayerId);
        break;
      case 'match_finished':
        setMatch(msg.match);
        setView(msg.view);
        setPanel(msg.panel);
        clearReconnectInfo();
        break;
      // Another tab took this one's place — duplicating a tab copies the token that holds it. The
      // server has already taken this connection out of the room; all that is left is to stop
      // looking like a game, and above all to drop the token, or the next reconnect would take the
      // place straight back off the tab that now has it.
      case 'seat_taken_over':
        setLobby(null);
        setMatch(null);
        setView(null);
        setPanel(undefined);
        setOwnPlayerId(null);
        setIsSpectator(false);
        setIsHost(false);
        clearReconnectInfo();
        setNotice('This game was opened in another tab, and continues there.');
        break;
      case 'match_closed':
        // The match ran out its summary and is gone.
        setMatch(null);
        setView(null);
        setPanel(undefined);
        setOwnPlayerId(null);
        setIsSpectator(false);
        setIsHost(false);
        clearReconnectInfo();
        break;
      case 'lobby_abandoned':
        setLobby(null);
        setOwnPlayerId(null);
        setIsSpectator(false);
        setIsHost(false);
        clearReconnectInfo();
        break;
      case 'error':
        setError(msg.message);
        break;
    }
  }, []);

  const { send, connected, generation: connectionGeneration, sessionId } = useWebSocket(handleMessage);

  const createLobby = useCallback((isLocal = true) => {
    send({ type: 'create_lobby', isLocal });
    setError(null);
    setNotice(null);
  }, [send]);

  const joinLobby = useCallback((inviteCode: string, playerName: string) => {
    send({ type: 'join_lobby', inviteCode, playerName });
    setError(null);
    setNotice(null);
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
    setIsHost(false);
    clearReconnectInfo();
  }, [send]);

  const spectate = useCallback((id: string) => {
    // Watching is not a place in the room, so whatever this tab was holding is not what it is now.
    clearReconnectInfo();
    send({ type: 'spectate', id });
    setRoomGeneration((value) => value + 1);
    setIsSpectator(true);
  }, [send]);

  const voteRematch = useCallback((matchId: string, playerId: string, answer: RematchAnswer | 'neutral') => {
    send({ type: 'rematch_vote', matchId, playerId, answer });
  }, [send]);

  const swapPlayers = useCallback((lobbyId: string) => {
    send({ type: 'swap_players', lobbyId });
  }, [send]);

  return {
    lobby,
    match,
    view,
    panel,
    modes,
    error,
    notice,
    connected,
    connectionGeneration,
    connectionSessionId: sessionId,
    roomGeneration,
    send,
    ownPlayerId,
    isSpectator,
    isHost,
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
