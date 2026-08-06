import type { DartThrow, GameSettings, Visit, ScoreResult, Lobby, GameState } from './types';
import type { BoardTip } from './vision/types';

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

export interface AddDartMessage {
  type: 'add_dart';
  gameId: string;
  dart: DartThrow;
}

export interface UndoDartMessage {
  type: 'undo_dart';
  gameId: string;
}

export interface SubmitVisitMessage {
  type: 'submit_visit';
  gameId: string;
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
  gameId?: string;
  lobbyId?: string;
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

// ============================================================
// Client → Server: scoring devices
//
// Two kinds of client speak these. A *frontend* pairs and grabs devices; a *scoring device* proves
// who it is and reports what its camera saw. They share one socket path and one session model, and
// a connection is only ever one of the two.
// ============================================================

/** Frontend: mint a short code for a scoring device to redeem. */
export interface CreatePairingCodeMessage {
  type: 'create_pairing_code';
}

/**
 * Frontend: take these devices for this session. Sent on every (re)connect for the devices this
 * tab has active, which is also how a pairing survives a server restart.
 */
export interface ActivateDevicesMessage {
  type: 'activate_devices';
  devices: { deviceId: string; tokenHash: string; grabbedAt: number }[];
}

/** Frontend: give a device back, so another tab or another user can take it. */
export interface DeactivateDeviceMessage {
  type: 'deactivate_device';
  deviceId: string;
}

/** Scoring device: redeem a pairing code and be issued an identity. */
export interface ScorerPairMessage {
  type: 'scorer_pair';
  code: string;
}

/** Scoring device: prove who it is with the token it was issued. */
export interface ScorerHelloMessage {
  type: 'scorer_hello';
  deviceId: string;
  token: string;
}

/** Scoring device: its camera started or stopped. Starting one is what makes it a camera. */
export interface ScorerCameraMessage {
  type: 'scorer_camera';
  active: boolean;
}

/**
 * Scoring device: one inference's dart tips, already projected into board space by the device.
 *
 * An empty array is meaningful, not a no-op: it is the takeout signal. It is only ever sent for a
 * frame that produced a homography, so "the board moved out of view" cannot be mistaken for "the
 * darts came out".
 */
export interface ScorerTipsMessage {
  type: 'scorer_tips';
  tips: BoardTip[];
  /** How long the inference took on the device, in milliseconds. Informational. */
  ms?: number;
}

export type ClientMessage =
  | CreateLobbyMessage
  | JoinLobbyMessage
  | AddLocalPlayerMessage
  | RemovePlayerMessage
  | UpdateSettingsMessage
  | SetPlayerNameMessage
  | AddDartMessage
  | UndoDartMessage
  | SubmitVisitMessage
  | StartGameMessage
  | LeaveGameMessage
  | ReconnectMessage
  | SpectateMessage
  | SwapPlayersMessage
  | CreatePairingCodeMessage
  | ActivateDevicesMessage
  | DeactivateDeviceMessage
  | ScorerPairMessage
  | ScorerHelloMessage
  | ScorerCameraMessage
  | ScorerTipsMessage;

// ============================================================
// Server → Client messages
// ============================================================

export interface LobbyStateMessage {
  type: 'lobby_state';
  lobby: Lobby;
  yourPlayerId?: string;
}

export interface GameStateMessage {
  type: 'game_state';
  game: GameState;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface GameStartedMessage {
  type: 'game_started';
  game: GameState;
}

export interface GameFinishedMessage {
  type: 'game_finished';
  game: GameState;
}

export interface LobbyAbandonedMessage {
  type: 'lobby_abandoned';
}

// ============================================================
// Server → Client: scoring devices
// ============================================================

/** To a frontend: show this code until it expires. */
export interface PairingCodeMessage {
  type: 'pairing_code';
  code: string;
  expiresAt: number;
}

/**
 * To a frontend: a device just paired with your code. Persist it — the server will not remember it
 * across a restart, and this hash is what re-establishes the pairing afterwards.
 */
export interface DevicePairedMessage {
  type: 'device_paired';
  deviceId: string;
  tokenHash: string;
}

/** To a frontend: how the devices it has active are doing. Sent on every change. */
export interface DevicesStateMessage {
  type: 'devices_state';
  devices: { deviceId: string; online: boolean; cameraActive: boolean }[];
}

/** To a frontend: another tab took this device. Stop trying to grab it. */
export interface DeviceLostMessage {
  type: 'device_lost';
  deviceId: string;
}

/** To a scoring device: it is paired, and these are its credentials. Store them. */
export interface ScorerPairedMessage {
  type: 'scorer_paired';
  deviceId: string;
  token: string;
}

/**
 * To a scoring device: everything it needs to show. A projection of the match, never the match —
 * a scoring device has no business holding the game state.
 */
export interface ScorerStateMessage {
  type: 'scorer_state';
  status: 'unpaired' | 'waiting' | 'active';
  /** How many cameras the server is hearing from for this match, including this one. */
  cameras: number;
  match: {
    players: { name: string; remaining: number; active: boolean }[];
    visit: string[];
  } | null;
}

/** To a scoring device: its identity was not accepted. Terminal — stop and pair again. */
export interface ScorerRefusedMessage {
  type: 'scorer_refused';
  reason: 'unpaired' | 'bad_code';
}

export type ServerMessage =
  | LobbyStateMessage
  | GameStateMessage
  | ErrorMessage
  | GameStartedMessage
  | GameFinishedMessage
  | LobbyAbandonedMessage
  | PairingCodeMessage
  | DevicePairedMessage
  | DevicesStateMessage
  | DeviceLostMessage
  | ScorerPairedMessage
  | ScorerStateMessage
  | ScorerRefusedMessage;

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
