import type { DartThrow, MatchSettings, Visit, ScoreResult, Lobby, MatchState, ModePanel, ModeView } from './types';
import type { ModeDescriptor } from './settings';
import type { BoardTip } from './vision/types';
import type { MediaPeer, MediaTier, SignalDescription } from './media';
import type { ClientConfig } from './config';

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

/**
 * A reloaded tab asking for its place back.
 *
 * It names a room and presents the token it was given when it took a place there; **which** place —
 * which player, and whether the host chair comes with it — is the server's own record, not something
 * this message gets to say. A page load mints a new session id, so the token is the only thing that
 * distinguishes the player coming back from anybody else who watched the room and read the ids out
 * of the state they were sent.
 */
export interface ReconnectMessage {
  type: 'reconnect';
  matchId?: string;
  lobbyId?: string;
  token: string;
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

/**
 * Frontend: ask one of its devices to start or stop its camera.
 *
 * An ask, not a command. Stopping always works; starting is the phone's browser to refuse — a
 * backgrounded tab or a permission that was never granted both fail, and the device says so through
 * `scorer_camera`. Nothing here is ever assumed to have taken effect.
 */
export interface SetDeviceCameraMessage {
  type: 'set_device_camera';
  deviceId: string;
  active: boolean;
}

/**
 * Frontend: send one of its devices to standby — camera off, wake lock released, socket closed.
 *
 * Deliberately one-way. There is no matching power-on, because nothing can wake a sleeping phone;
 * whoever powers a device off is choosing to walk over to it before it scores again.
 */
export interface PowerOffDeviceMessage {
  type: 'power_off_device';
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
 *
 * Only the credentials go. The name, the lens calibration, the zoom and the power delays all
 * describe this phone on this mount, and none of that changed by it being handed to somebody else.
 */
export interface ScorerUnpairMessage {
  type: 'scorer_unpair';
}

/**
 * Scoring device: it was renamed. The device owns its own name; the frontend just displays it.
 *
 * Sent again the moment it pairs, because the name describes the phone rather than the pairing and
 * survives being handed to somebody else — so a new owner is told what it is called instead of
 * keeping the placeholder it invented.
 */
export interface ScorerNameMessage {
  type: 'scorer_name';
  name: string;
}

/** Scoring device: its camera started or stopped. Starting one is what makes it a camera. */
export interface ScorerCameraMessage {
  type: 'scorer_camera';
  active: boolean;
  /**
   * Why it is not on, when a start was attempted and failed. Carried so the frontend's switch can
   * show a refusal instead of sitting on "starting…" forever — a camera can fail to open for
   * reasons only the phone knows about.
   */
  error?: string;
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

// ============================================================
// Client → Server: media
//
// The second prefix both kinds of client speak, and the server's whole involvement is deciding who
// may reach whom — see shared/media.ts. A scoring device sends `media_ready` and `media_signal`;
// only a frontend has a board camera to nominate.
// ============================================================

/**
 * Take part in media, and say how much this peer is willing to send.
 *
 * A client that never sends this is invisible to the feature, which is how a per-browser or
 * per-phone opt-out works — there is no separate "disabled" state to keep in step with anything.
 *
 * For a **scoring device** this is only the first of two gates. Announcing a tier says the phone is
 * willing; it does not put the device in anybody's roster on its own, because whether a board is
 * watched is its owner's decision and arrives separately as `media_select_camera`.
 *
 * Sent again whenever the tier changes, so a phone switched from stills to video is not stuck at
 * whatever it happened to be when it connected.
 */
export interface MediaReadyMessage {
  type: 'media_ready';
  tier: MediaTier;
}

/**
 * A frontend nominating one of its claimed scoring devices as **the** board camera, or `null` for
 * none.
 *
 * At most one, deliberately. It is the picture the owner watches and the same picture the opponent
 * is offered, so "which board am I showing" has exactly one answer rather than one per viewer —
 * and nominating nothing is a complete opt-out that the opponent cannot work around.
 *
 * Only ever honoured for a device this connection actually holds; naming somebody else's gets
 * silence. Re-sent on every connect, like `activate_devices`, since the server keeps nothing.
 */
export interface MediaSelectCameraMessage {
  type: 'media_select_camera';
  deviceId: string | null;
}

/** Stop taking part. Every peer holding a link to this one is told by the roster it gets next. */
export interface MediaLeaveMessage {
  type: 'media_leave';
}

/**
 * One end of a negotiation, for the server to hand to exactly one other peer.
 *
 * `to` must be in this peer's current roster — recomputed at the moment the message arrives, never
 * remembered. That is the whole authorization model: the server relays between two peers it paired
 * itself, and refuses everything else in silence.
 */
export interface MediaSignalMessage {
  type: 'media_signal';
  to: string;
  description: SignalDescription;
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
  | SetDeviceCameraMessage
  | PowerOffDeviceMessage
  | ScorerPairMessage
  | ScorerHelloMessage
  | ScorerUnpairMessage
  | ScorerNameMessage
  | ScorerCameraMessage
  | ScorerTipsMessage
  | MediaReadyMessage
  | MediaLeaveMessage
  | MediaSelectCameraMessage
  | MediaSignalMessage;

// ============================================================
// Server → Client messages
// ============================================================

export interface LobbyStateMessage {
  type: 'lobby_state';
  lobby: Lobby;
  yourPlayerId?: string;
  /**
   * Whether the receiving connection created this lobby — the answer to a question it used to work
   * out for itself by comparing session ids, which meant everybody was told the creator's.
   *
   * Present only on a message addressed to one connection, and then always: `true` and `false` both
   * mean "this is about you", while a broadcast carries no field at all and settles nothing.
   */
  youAreHost?: boolean;
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
  /**
   * Which player is the receiving connection's own — set only on a reply to one connection, never on
   * a broadcast, and never in a local match where one user holds them all. It is how a tab that has
   * just reloaded into a match knows which side is its own, which it can no longer work out from the
   * players themselves.
   */
  yourPlayerId?: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

/**
 * Somebody else took this tab's place, and it has none any more.
 *
 * A seat is held by one connection at a time, so presenting its token elsewhere hands it over —
 * which is what duplicating a tab does, since duplication copies the storage the token lives in.
 * The tab told this has already stopped being a participant server-side; it drops what it was
 * holding rather than sitting there looking like a game it can no longer play.
 */
export interface SeatTakenOverMessage {
  type: 'seat_taken_over';
}

/**
 * What to present if this tab is loaded again, and for which room.
 *
 * Sent only to the connection it belongs to — never broadcast, never part of a lobby or a match,
 * both of which go to everyone in the room. A spectator is never sent one, which is what makes
 * "watching" a thing that cannot be reloaded into "playing".
 *
 * Arrives again whenever the room changes id under the same seat: starting a match, and a re-match.
 * The token itself does not change, so a tab that missed one is not locked out.
 */
export interface ResumeMessage {
  type: 'resume';
  lobbyId?: string;
  matchId?: string;
  token: string;
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
  devices: {
    deviceId: string;
    name: string;
    online: boolean;
    cameraActive: boolean;
    /**
     * How much of its view this device is willing to share, as the phone itself decided. `disabled`
     * means it may not be nominated as the board camera at all — the picker shows why rather than
     * silently omitting it.
     */
    media: MediaTier;
    /** The device's last reason for not having a camera on, if it tried and failed. */
    cameraError?: string;
  }[];
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
  /**
   * Whether a match is running that this device's tips would feed — the same question the server
   * already asks before it accepts any, so the two cannot disagree.
   *
   * Distinct from `status`, which only says a frontend has claimed this device. The gap between the
   * two is a device claimed all evening between legs, and it is the whole reason a device can now
   * decide for itself when to power down.
   */
  scoring: boolean;
  /**
   * Opaque identity of the match and board this device currently feeds. Stable across socket
   * reconnects; changes for a new match, a rematch, or a different player's board.
   */
  scoringContextId: string | null;
  /** How many cameras the server is hearing from for this match, including this one. */
  cameras: number;
}

/**
 * To a scoring device: its owner is asking it to do something.
 *
 * Advisory in both directions. `camera_on` may simply fail on the phone, and `power_off` is the
 * last thing that connection will hear — there is no acknowledgement because there is nothing left
 * to acknowledge with.
 */
export interface ScorerCommandMessage {
  type: 'scorer_command';
  command: 'camera_on' | 'camera_off' | 'power_off';
}

/**
 * To a scoring device: it cannot go on, and why.
 *
 * The reason decides what the device does with what it holds, so the three are not interchangeable:
 * `unpaired` means the server does not know this identity and it is worth nothing, so the device
 * discards it; `bad_code` is a failed pairing attempt, with nothing to discard; `server_full` is
 * the server having no room right now, which says nothing about the pairing — a device told this
 * **keeps its identity** and can come back later.
 */
export interface ScorerRefusedMessage {
  type: 'scorer_refused';
  reason: 'unpaired' | 'bad_code' | 'server_full';
}

// ============================================================
// Server → Client: media
// ============================================================

/**
 * How this deployment is tuned, sent on connect to frontends and scoring devices alike — the same
 * moment and the same reason as `mode_catalog`.
 *
 * Everything a client is entitled to, in one message: what it may do with media, and the handful of
 * numbers a phone or a browser runs by. The server's own section is deliberately not in it — how big
 * this server is sized for is nobody's business at the other end of a socket.
 *
 * Sent even when media is off, so a client learns the answer rather than waiting for a message that
 * will never arrive.
 */
export interface AppConfigMessage extends ClientConfig {
  type: 'app_config';
}

/**
 * Who this peer may open a link to. A retained topic like `devices_state`: pushed on every change,
 * and authoritative in **both** directions.
 *
 * A peer that has vanished from the list is a link to close. That is what tears links down when
 * somebody leaves, when a match closes and when a phone drops off the Wi-Fi, without a teardown
 * message existing anywhere in this protocol.
 */
export interface MediaPeersMessage {
  type: 'media_peers';
  /** This connection's own peer id, so it can tell itself apart in anything it is shown. */
  self: string;
  peers: MediaPeer[];
}

/** One end of a negotiation, from a peer the server has paired with this one. */
export interface MediaSignalRelayMessage {
  type: 'media_signal';
  from: string;
  description: SignalDescription;
}

export type ServerMessage =
  | LobbyStateMessage
  | MatchStateMessage
  | ModeCatalogMessage
  | ErrorMessage
  | ResumeMessage
  | SeatTakenOverMessage
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
  | ScorerCommandMessage
  | ScorerRefusedMessage
  | AppConfigMessage
  | MediaPeersMessage
  | MediaSignalRelayMessage;

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
