import type { DartThrow, MatchSettings, Visit, ScoreResult, Lobby, MatchState, ModePanel, ModeView } from './types';
import type { ModeDescriptor } from './settings';
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
  settings: MatchSettings;
}

export interface SetPlayerNameMessage {
  type: 'set_player_name';
  lobbyId: string;
  playerId: string;
  name: string;
}

export interface AddDartMessage {
  type: 'add_dart';
  matchId: string;
  dart: DartThrow;
}

export interface UndoDartMessage {
  type: 'undo_dart';
  matchId: string;
}

export interface SubmitVisitMessage {
  type: 'submit_visit';
  matchId: string;
}

export interface StartMatchMessage {
  type: 'start_match';
  lobbyId: string;
}

export interface LeaveMatchMessage {
  type: 'leave_match';
  matchId: string;
}

export interface ReconnectMessage {
  type: 'reconnect';
  matchId?: string;
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

/**
 * A player accepting, or withdrawing, a re-match. Every participant accepting starts one.
 *
 * A user may only vote for a player of their own session — which in a local match is both of them.
 */
export interface RematchVoteMessage {
  type: 'rematch_vote';
  matchId: string;
  playerId: string;
  /** 'neutral' takes an answer back; the deadline turns anything still neutral into a decline. */
  answer: 'accepted' | 'declined' | 'neutral';
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
  /** What this device calls itself. Carried on every hello, since the server forgets it. */
  name?: string;
}

/**
 * Scoring device: forget the pairing and go back to the code screen.
 *
 * One-sided on purpose. The device drops its token, the server drops the socket binding, and the
 * frontend that paired it is told nothing — it holds a claim on an id that will never connect
 * again, which looks to it exactly like a phone that was switched off for good. That is the price
 * of the device being able to unpair itself without the other side's cooperation.
 */
export interface ScorerUnpairMessage {
  type: 'scorer_unpair';
}

/** Scoring device: it was renamed. The device owns its own name; the frontend just displays it. */
export interface ScorerNameMessage {
  type: 'scorer_name';
  name: string;
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
  | StartMatchMessage
  | LeaveMatchMessage
  | ReconnectMessage
  | SpectateMessage
  | SwapPlayersMessage
  | RematchVoteMessage
  | CreatePairingCodeMessage
  | ActivateDevicesMessage
  | DeactivateDeviceMessage
  | ScorerPairMessage
  | ScorerHelloMessage
  | ScorerUnpairMessage
  | ScorerNameMessage
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

/**
 * Which game modes this deployment has, and what each calls its settings.
 *
 * Sent once on connect. It is what lets the lobby offer modes and render their settings without
 * importing a line of any mode's code — a mode is installed by adding a file to the server.
 */
export interface ModeCatalogMessage {
  type: 'mode_catalog';
  modes: ModeDescriptor[];
}

/**
 * The match, what the game mode says to show for the current leg, and its own block of the screen.
 *
 * The view is the leg's; the panel is the match's. Both travel with every match message so the
 * client never has to derive a mode-specific value itself.
 */
export interface MatchStateMessage {
  type: 'match_state';
  match: MatchState;
  view: ModeView;
  panel?: ModePanel;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface MatchStartedMessage {
  type: 'match_started';
  match: MatchState;
  view: ModeView;
  panel?: ModePanel;
}

export interface MatchFinishedMessage {
  type: 'match_finished';
  match: MatchState;
  view: ModeView;
  panel?: ModePanel;
}

/**
 * This match is over and gone: its summary ran out. Everyone still on it — players and spectators —
 * goes home. Nothing lingers on the server without an end.
 */
export interface MatchClosedMessage {
  type: 'match_closed';
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
  devices: { deviceId: string; name: string; online: boolean; cameraActive: boolean }[];
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
 * a scoring device has no business holding the match state.
 */
export interface ScorerStateMessage {
  type: 'scorer_state';
  status: 'unpaired' | 'waiting' | 'active';
  /** How many cameras the server is hearing from for this match, including this one. */
  cameras: number;
}

/** To a scoring device: its identity was not accepted. Terminal — stop and pair again. */
export interface ScorerRefusedMessage {
  type: 'scorer_refused';
  reason: 'unpaired' | 'bad_code';
}

export type ServerMessage =
  | LobbyStateMessage
  | MatchStateMessage
  | ModeCatalogMessage
  | ErrorMessage
  | MatchStartedMessage
  | MatchFinishedMessage
  | LobbyAbandonedMessage
  | MatchClosedMessage
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
