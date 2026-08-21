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
  /**
   * This match has no media mesh because of its own shape — more than two boards. Told by the
   * server rather than worked out here, so "how many boards is too many" is stated once.
   */
  const [mediaDisabled, setMediaDisabled] = useState(false);
  /** What this deployment can play. Sent once on connect; the lobby is built from it. */
  const [modes, setModes] = useState<ModeDescriptor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ownPlayerIds, setOwnPlayerIds] = useState<string[]>([]);
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
        // Only a message addressed to this connection names its players; a broadcast names nobody's.
        // So "mine is gone" cannot be said by the absence of the field — it is the player itself no
        // longer being in the lobby, which is what removing your own player looks like from here.
        if (msg.yourPlayerIds !== undefined) setOwnPlayerIds(msg.yourPlayerIds);
        else setOwnPlayerIds((mine) => mine.filter((id) => msg.lobby.players.some((p: Player) => p.id === id)));
        // Addressed either way — `false` is as much an answer as `true`, and only a broadcast leaves
        // the question alone.
        if (msg.youAreHost !== undefined) setIsHost(msg.youAreHost);
        if (msg.youAreSpectator !== undefined) setIsSpectator(msg.youAreSpectator);
        break;
      case 'mode_catalog':
        setModes(msg.modes);
        break;
      case 'match_state':
      case 'match_started':
        setMatch(msg.match);
        setView(msg.view);
        setPanel(msg.panel);
        setMediaDisabled(Boolean(msg.mediaDisabled));
        setLobby(null);
        // Only a reply to this connection carries one, and it is how a reloaded tab learns which
        // players are its own — the match itself no longer says who anybody belongs to.
        if (msg.yourPlayerIds !== undefined) setOwnPlayerIds(msg.yourPlayerIds);
        // And whether it is playing at all: a user who never added a player is taken out of the
        // roster when the match starts, and this is the only thing that tells its tab so.
        if (msg.youAreSpectator !== undefined) setIsSpectator(msg.youAreSpectator);
        break;
      case 'match_finished':
        setMatch(msg.match);
        setView(msg.view);
        setPanel(msg.panel);
        setMediaDisabled(Boolean(msg.mediaDisabled));
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
        setMediaDisabled(false);
        setOwnPlayerIds([]);
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
        setMediaDisabled(false);
        setOwnPlayerIds([]);
        setIsSpectator(false);
        setIsHost(false);
        clearReconnectInfo();
        break;
      case 'lobby_abandoned':
        setLobby(null);
        setOwnPlayerIds([]);
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
    setMediaDisabled(false);
    setOwnPlayerIds([]);
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

  const reorderPlayer = useCallback((lobbyId: string, playerId: string, direction: 'up' | 'down') => {
    send({ type: 'reorder_player', lobbyId, playerId, direction });
  }, [send]);

  return {
    lobby,
    match,
    view,
    panel,
    mediaDisabled,
    modes,
    error,
    notice,
    connected,
    connectionGeneration,
    connectionSessionId: sessionId,
    roomGeneration,
    send,
    ownPlayerIds,
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
    reorderPlayer,
    voteRematch,
  };
}
