import type { GameSettings, Visit } from './types';

// ============================================================
// Client → Server messages
// ============================================================

export interface CreateLobbyMessage {
  type: 'create_lobby';
  isLocal?: boolean;
}

export interface JoinLobbyMessage {
  type: 'join_lobby';
  lobbyId?: string;
  inviteCode?: string;
  playerName: string;
}

export interface AddLocalPlayerMessage {
  type: 'add_local_player';
  lobbyId: string;
  playerName: string;
}

export interface RemovePlayerMessage {
  type: 'remove_player';
  lobbyId: string;
  playerId: string;
}

export interface UpdateSettingsMessage {
  type: 'update_settings';
  lobbyId: string;
  settings: GameSettings;
}

export interface SetPlayerNameMessage {
  type: 'set_player_name';
  lobbyId: string;
  playerId: string;
  name: string;
}

export interface SubmitVisitMessage {
  type: 'submit_visit';
  gameId: string;
  visit: Omit<Visit, 'visitNumber'>;
}

export interface StartGameMessage {
  type: 'start_game';
  lobbyId: string;
}

export interface LeaveGameMessage {
  type: 'leave_game';
  gameId: string;
}

export interface ReconnectMessage {
  type: 'reconnect';
  gameId: string;
  playerId: string;
}

export interface SpectateMessage {
  type: 'spectate';
  id: string;
}

export interface SwapPlayersMessage {
  type: 'swap_players';
  lobbyId: string;
}

export type ClientMessage =
  | CreateLobbyMessage
  | JoinLobbyMessage
  | AddLocalPlayerMessage
  | RemovePlayerMessage
  | UpdateSettingsMessage
  | SetPlayerNameMessage
  | SubmitVisitMessage
  | StartGameMessage
  | LeaveGameMessage
  | ReconnectMessage
  | SpectateMessage
  | SwapPlayersMessage;

// ============================================================
// Server → Client messages
// ============================================================

export interface LobbyStateMessage {
  type: 'lobby_state';
  lobby: import('./types').Lobby;
  yourPlayerId?: string;
}

export interface GameStateMessage {
  type: 'game_state';
  game: import('./types').GameState;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface PlayerJoinedMessage {
  type: 'player_joined';
  lobbyId: string;
  player: import('./types').Player;
}

export interface PlayerLeftMessage {
  type: 'player_left';
  lobbyId: string;
  playerId: string;
}

export interface GameStartedMessage {
  type: 'game_started';
  game: import('./types').GameState;
}

export interface GameFinishedMessage {
  type: 'game_finished';
  game: import('./types').GameState;
}

export interface LobbyAbandonedMessage {
  type: 'lobby_abandoned';
}

export type ServerMessage =
  | LobbyStateMessage
  | GameStateMessage
  | ErrorMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | GameStartedMessage
  | GameFinishedMessage
  | LobbyAbandonedMessage;

// ============================================================
// Helpers
// ============================================================

export function parseMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (typeof msg.type === 'string') return msg as ClientMessage;
    return null;
  } catch {
    return null;
  }
}

export function formatMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
