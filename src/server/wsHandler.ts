// The gameplay half of the socket layer: lobbies, matches, spectating, re-matches, and the routing
// that every message arrives through.
//
// Three things it deliberately does not hold. **Who is connected** is connections.ts — the registry
// and the ways of addressing it, which the scoring-device handlers need just as much as these do.
// **Scoring devices** are scoringDevices.ts, which shares nothing with this file but that registry
// and `commitScoredMatch` — the one function through which a match moves, whether its darts were
// clicked here or seen by a camera there. **Media** is media.ts, which shares only the registry: it
// needs to know when somebody changes room, and this file is where that happens.
//
// Every handler below takes a message that has been parsed but not validated: `parseMessage` checks
// that a `type` is present and nothing else, so the shape each handler reads is its own to check.

import type { WebSocket } from 'ws';
import type { MatchState, Lobby } from '../shared/types';
import type { Client } from './types';
import { parseMessage } from '../shared/protocol';
import { createLobby, getLobby, addPlayerToLobby, removePlayerFromLobby, createMatch, createRematch, getMatch, findLobbyByInviteCode, deleteLobby, deleteMatch, swapLobbyPlayers } from './store';
import { generatePlayerId } from './player';
import { addDartToMatch, undoDartFromMatch, submitVisitToMatch } from './match';
import { generateInviteCode } from './invite';
import { sanitizeName, validateSettings, validateDartThrow } from './validation';
import { checkRateLimit, checkSignalRateLimit, checkTipsRateLimit, releaseRateLimit } from './rateLimit';
import { CONFIG } from './config';
import {
  handleMediaLeave,
  handleMediaJoin,
  handleMediaReady,
  handleMediaSignal,
  syncDeviceTier,
  mediaRoomOf,
  publishMediaFor,
  publishMediaForRoom,
  releaseMediaState,
  sendAppConfig,
  startMediaForMatch,
  finishMediaForMatch,
} from './media';
import { dropScoringSessions } from './scoring/store';
import { grantSeat, heldSeat, holdsSeat, redeemSeat, revokeSeat, updateSeat, type Seat } from './seats';
import { allModes, describeMode } from './modes/types';
import { canCreateLobby, canCreateMatch } from './capacity';
import { SUMMARY_TTL_MS, setLifecycleHandlers, touch } from './lifecycle';
import {
  addClient,
  allClients,
  broadcastToLobby,
  broadcastToMatch,
  dropClient,
  findSessionSocket,
  getClient,
  lobbyMessage,
  matchMessage,
  send,
} from './connections';
import {
  commitScoredMatch,
  devicesScoringInto,
  handleActivateDevices,
  handleCreatePairingCode,
  handleDeactivateDevice,
  handlePowerOffDevice,
  handleScorerCamera,
  handleScorerHello,
  handleScorerName,
  handleScorerPair,
  handleScorerTips,
  handleScorerUnpair,
  handleSetDeviceCamera,
  publishScorerStateFor,
  releaseScoringState,
} from './scoringDevices';

// ============================================================
// Connection lifetime
//
// Who is connected lives in connections.ts. What is here is what a *disconnection* means, which is
// not the same thing: a page reload looks exactly like leaving, so leaving is deferred long enough
// for a reload to come back and claim its place.
// ============================================================

const DISCONNECT_GRACE_MS = 3000;
const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>();

function disconnectKey(client: Client): string | null {
  if (client.lobbyId && client.playerId) return `lobby:${client.lobbyId}:${client.playerId}`;
  if (client.lobbyId) return `lobby:${client.lobbyId}:`;
  if (client.matchId && client.playerId) return `match:${client.matchId}:${client.playerId}`;
  return null;
}

export function scheduleDisconnect(ws: WebSocket, onTimeout: () => void): void {
  const client = getClient(ws);
  if (!client) { onTimeout(); return; }

  const key = disconnectKey(client);
  if (!key) { onTimeout(); return; }

  const timer = setTimeout(() => {
    pendingDisconnects.delete(key);
    onTimeout();
  }, DISCONNECT_GRACE_MS);
  pendingDisconnects.set(key, timer);
}

function cancelDisconnect(key: string): void {
  const timer = pendingDisconnects.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingDisconnects.delete(key);
  }
}

/**
 * Cancel every pending disconnect for a match.
 *
 * For a **local** match, which is one user holding every player: the key a disconnect was filed
 * under names whichever player that connection was associated with, and a reloading client cannot
 * know which one that was. Their return covers all of them, because there is nobody else it could
 * be. An online match is left alone — one player coming back says nothing about the other.
 */
function cancelDisconnectsForMatch(matchId: string): void {
  for (const key of [...pendingDisconnects.keys()]) {
    if (key.startsWith(`match:${matchId}:`)) cancelDisconnect(key);
  }
}

export function registerClient(ws: WebSocket, client: Client): void {
  addClient(ws, client);
  // What this deployment can play. The client renders the lobby from it and imports no mode code.
  send(ws, { type: 'mode_catalog', modes: allModes().map(describeMode) });
  // And how this deployment is tuned — whether it carries video, and the numbers a phone or a
  // browser runs by. Neither can guess any of it. Sent even when media is off, so nobody waits.
  sendAppConfig(ws);
}

export function removeClient(ws: WebSocket): void {
  const client = getClient(ws);
  if (client) {
    // The keys the buckets were actually filled under: a frontend spends from its session's
    // budget, a scoring device from its device's. This used to pass `playerId`, which is neither,
    // and so deleted a bucket called "".
    releaseRateLimit(client.sessionId, client.deviceId);
    releaseScoringState(client);
  }
  // Before the socket leaves the registry, or the room it was in cannot be worked out any more.
  releaseMediaState(ws);
  dropClient(ws);
}

// ============================================================
// Seats
//
// A place in a room and the token that proves it — see seats.ts. Everything here is *when* one is
// handed out; the rules of what it stands for live there.
// ============================================================

/** Tell a connection what to present if its tab is loaded again. Never broadcast. */
function sendResume(ws: WebSocket, room: { lobbyId?: string; matchId?: string }, token: string): void {
  send(ws, { type: 'resume', ...room, token });
}

/**
 * The place this session held has been taken by another connection.
 *
 * Two things happen, and the order matters. The old connection stops being a participant *here* —
 * it is out of the room before the new one is told anything, so there is never a moment with two
 * occupants — and then it is told, so its tab can drop what it was holding rather than sitting on a
 * screen it can no longer act on.
 *
 * The socket is deliberately left open. Closing it would send that tab straight back through its own
 * reconnect, token in hand, to take the seat back — the two would trade it forever. What ends the
 * participation is losing the seat, not losing the connection.
 */
function releaseTakenSeat(sessionId: string, roomId: string): void {
  const ws = findSessionSocket(sessionId);
  if (!ws) return;
  const client = getClient(ws);
  if (!client) return;
  if (client.lobbyId !== roomId && client.matchId !== roomId) return;

  const devices = client.matchId ? devicesScoringInto(client.matchId) : [];
  client.lobbyId = null;
  client.matchId = null;
  client.playerId = null;
  client.isSpectator = false;
  send(ws, { type: 'seat_taken_over' });
  // It is out of the room, so the room's cameras and peers are no longer its business.
  publishScorerStateFor(devices);
  publishMediaFor(ws, roomId);
}

/**
 * The seat this connection holds in this room, taking one if it has none.
 *
 * Idempotent on purpose: a user who joins their own lobby again, or adds a second player to a local
 * one, must come away holding the token their tab already stored rather than a fresher one it has
 * no way of hearing about.
 */
function claimSeat(roomId: string, client: Client, seat: Seat): string {
  const held = heldSeat(roomId, client.sessionId);
  if (!held) return grantSeat(roomId, client.sessionId, seat);
  // A room taken before there was a player to take it as — the host creating a lobby — is filled in
  // by the first player added on that seat.
  if (held.seat.playerId === null && seat.playerId) updateSeat(roomId, held.token, { playerId: seat.playerId });
  return held.token;
}

// ============================================================
// Request guards
// ============================================================

/**
 * The room this connection may act as a participant in, or null.
 *
 * **Holding the seat is the requirement, not a state we keep in step with one.** The `Client` record
 * says what a connection was last told it may do; the [seat](./seats.ts) says who may do it *now*,
 * and where the two disagree the seat is right. Every entry point into a lobby or a match goes
 * through one of these, so a connection whose place was taken over cannot act on either — and it is
 * refused because it does not hold the place, rather than because something remembered to demote it.
 */
function seatedInLobby(ws: WebSocket): { client: Client; lobbyId: string } | null {
  const client = getClient(ws);
  if (!client?.lobbyId || client.isSpectator) return null;
  return holdsSeat(client.lobbyId, client.sessionId) ? { client, lobbyId: client.lobbyId } : null;
}

/** The match this connection may play in, or null. See `seatedInLobby`. */
function seatedInMatch(ws: WebSocket): { client: Client; matchId: string } | null {
  const client = getClient(ws);
  if (!client?.matchId || client.isSpectator) return null;
  return holdsSeat(client.matchId, client.sessionId) ? { client, matchId: client.matchId } : null;
}

/** Validates that the client is playing in an active match. Returns client+match or null (error already sent). */
function requireMatch(ws: WebSocket): { client: Client; match: MatchState } | null {
  const seated = seatedInMatch(ws);
  if (!seated) return null;
  const match = getMatch(seated.matchId);
  if (!match) { send(ws, { type: 'error', message: 'Match not found' }); return null; }
  return { client: seated.client, match };
}

/** Validates that the client is in a lobby. Returns client+lobby or null. Does NOT send errors for silent-return handlers. */
function requireLobby(ws: WebSocket): { client: Client; lobby: Lobby } | null {
  const seated = seatedInLobby(ws);
  if (!seated) return null;
  const lobby = getLobby(seated.lobbyId);
  if (!lobby) return null;
  return { client: seated.client, lobby };
}

// ============================================================
// Message routing
// ============================================================

export function handleMessage(ws: WebSocket, raw: string): void {
  const client = getClient(ws);

  const msg = parseMessage(raw);
  if (!msg) {
    send(ws, { type: 'error', message: 'Invalid message format' });
    return;
  }

  // Tips get their own budget. A camera on a fast phone publishes faster than a person clicks, and
  // one of the reports it would lose to the shared bucket is the empty one that ends the visit.
  if (msg.type === 'scorer_tips') {
    if (!client?.deviceId || !checkTipsRateLimit(client.deviceId)) return;
  } else if (msg.type === 'media_signal') {
    // Its own budget, because signaling arrives in bursts: a client joining a match negotiates every
    // link it has in one breath and then says nothing all evening.
    if (!checkSignalRateLimit(client?.deviceId ?? client?.sessionId ?? '')) return;
  } else if (!checkRateLimit(client?.sessionId ?? `anon_${Math.random()}`)) {
    send(ws, { type: 'error', message: 'Rate limit exceeded' });
    return;
  }

  // A connection is a frontend or a scoring device, never both. Keeping the two gameplay
  // vocabularies apart means a compromised scoring device cannot reach a single gameplay handler.
  //
  // `media_` is the one prefix both kinds speak, and that costs nothing here: a media handler is not
  // a gameplay handler, and every one of them is gated on the sender's roster — which the server
  // computed itself, and which a scoring device has no way to talk itself into.
  const isScorerMessage = msg.type.startsWith('scorer_');
  const isMediaMessage = msg.type.startsWith('media_');
  if (client?.deviceId && !isScorerMessage && !isMediaMessage) return;
  if (isScorerMessage && !client?.deviceId && msg.type !== 'scorer_pair' && msg.type !== 'scorer_hello') return;
  if (isMediaMessage && !CONFIG.media.enabled) return;

  // Where this connection was before the handler ran. A message that moves somebody has to refresh
  // the room it left as well as the one it joined, and afterwards there is no way to ask.
  const previousRoom = ROOM_CHANGING_TYPES.has(msg.type) ? mediaRoomOf(ws) : null;

  // Anything a participant does pushes the idle deadline back. Read after the handler has run, so
  // that a message which moves the client — starting a match — touches what it moved them into.
  // Deliberately not spectating or reconnecting: an audience must not keep a dead match alive.
  const isInput = INPUT_TYPES.has(msg.type);

  switch (msg.type) {
    case 'create_lobby':
      handleCreateLobby(ws, msg);
      break;
    case 'join_lobby':
      handleJoinLobby(ws, msg);
      break;
    case 'add_local_player':
      handleAddLocalPlayer(ws, msg);
      break;
    case 'remove_player':
      handleRemovePlayer(ws, msg);
      break;
    case 'update_settings':
      handleUpdateSettings(ws, msg);
      break;
    case 'set_player_name':
      handleSetPlayerName(ws, msg);
      break;
    case 'start_match':
      handleStartMatch(ws, msg);
      break;
    case 'add_dart':
      handleAddDart(ws, msg);
      break;
    case 'undo_dart':
      handleUndoDart(ws, msg);
      break;
    case 'submit_visit':
      handleSubmitVisit(ws, msg);
      break;
    case 'leave_match':
      handleLeaveMatch(ws, msg);
      break;
    case 'reconnect':
      handleReconnect(ws, msg);
      break;
    case 'spectate':
      handleSpectate(ws, msg);
      break;
    case 'swap_players':
      handleSwapPlayers(ws, msg);
      break;
    case 'rematch_vote':
      handleRematchVote(ws, msg);
      break;
    case 'create_pairing_code':
      handleCreatePairingCode(ws);
      break;
    case 'activate_devices':
      handleActivateDevices(ws, msg);
      break;
    case 'deactivate_device':
      handleDeactivateDevice(ws, msg);
      break;
    case 'set_device_camera':
      handleSetDeviceCamera(ws, msg);
      break;
    case 'power_off_device':
      handlePowerOffDevice(ws, msg);
      break;
    case 'scorer_pair':
      handleScorerPair(ws, msg);
      // A phone announces what it will share as soon as it connects, which is before it has proven
      // who it is. This is the moment there is finally a device to write that answer to.
      syncDeviceTier(ws);
      break;
    case 'scorer_hello':
      handleScorerHello(ws, msg);
      syncDeviceTier(ws);
      break;
    case 'scorer_unpair':
      handleScorerUnpair(ws);
      break;
    case 'scorer_name':
      handleScorerName(ws, msg);
      break;
    case 'scorer_camera':
      handleScorerCamera(ws, msg);
      break;
    case 'scorer_tips':
      handleScorerTips(ws, msg);
      break;
    case 'media_ready':
      handleMediaReady(ws, msg);
      break;
    case 'media_leave':
      handleMediaLeave(ws);
      break;
    case 'media_join':
      handleMediaJoin(ws, msg);
      break;
    case 'media_signal':
      handleMediaSignal(ws, msg);
      break;
    default:
      send(ws, { type: 'error', message: `Unknown message type: ${(msg as any).type}` });
  }

  if (isInput && client && !client.isSpectator) {
    const lobby = client.lobbyId ? getLobby(client.lobbyId) : undefined;
    if (lobby) touch(lobby);
    const match = client.matchId ? getMatch(client.matchId) : undefined;
    // A finished match is counting down its summary; input must not push that back.
    if (match && match.status === 'in_progress') touch(match);
  }

  // Somebody may have moved. Cheap to ask needlessly: an unchanged roster sends nothing. A
  // re-match is deliberately different — startMediaForMatch gives it a fresh mesh and every client
  // declaration below rebuilds its links from scratch.
  if (ROOM_CHANGING_TYPES.has(msg.type)) publishMediaFor(ws, previousRoom);
}

// ============================================================
// Deadlines
//
// Wired into the lifecycle sweep, which owns *when*; everything here is *what to tell people*.
// ============================================================

setLifecycleHandlers({
  /** Nobody has touched this match for the idle period. It is over, with no winner. */
  cancelIdleMatch(match: MatchState): void {
    endMatch(match, null);
    broadcastToMatch(match.id, matchMessage('match_finished', match));
    publishScorerStateFor(devicesScoringInto(match.id));
  },

  /**
   * A finished match has run out its summary. Anyone who never answered the re-match has, in effect,
   * declined — and then the match is gone and everyone still on it goes home.
   */
  closeMatch(match: MatchState): void {
    for (const player of match.players) {
      if (!match.rematchVotes[player.id]) match.rematchVotes[player.id] = 'declined';
    }
    broadcastToMatch(match.id, { type: 'match_closed' });
    // Captured before the clients are sent home: a device is found through its owner's `matchId`,
    // and the loop below is about to erase every one of them.
    const devices = devicesScoringInto(match.id);
    for (const [, client] of allClients()) {
      if (client.matchId !== match.id) continue;
      client.matchId = null;
      client.playerId = null;
      client.isSpectator = false;
    }
    dropScoringSessions(match.id);
    deleteMatch(match.id);
    publishScorerStateFor(devices);
    // The room is gone, so everyone who was in it is told they are alone, which is what closes
    // whatever peer connections they were holding.
    finishMediaForMatch(match.id);
  },

  /** A lobby nobody has touched for the idle period. */
  expireLobby(lobby: Lobby): void {
    for (const [ws, client] of allClients()) {
      if (client.lobbyId !== lobby.id) continue;
      send(ws, { type: 'lobby_abandoned' });
      client.lobbyId = null;
      client.playerId = null;
      client.isSpectator = false;
    }
    deleteLobby(lobby.id);
    publishMediaForRoom(lobby.id);
  },
});

/** Message types that count as input for the idle timeout. */
const INPUT_TYPES = new Set([
  'create_lobby', 'join_lobby', 'add_local_player', 'remove_player', 'set_player_name',
  'update_settings', 'swap_players', 'start_match',
  'add_dart', 'undo_dart', 'submit_visit', 'rematch_vote',
]);

/**
 * Message types after which somebody may be able to see somebody they could not before.
 *
 * Every one of these either moves a connection between a lobby and a match, changes who is in one,
 * or changes which scoring devices a session holds — and a media roster is derived from exactly
 * those three things. Anything not listed here cannot change one, so it is not worth asking.
 *
 * Deliberately generous rather than exact: an unchanged roster is not published, so a type listed
 * here that turns out not to have moved anything costs one derivation and no traffic. `add_local_player`
 * and `set_player_name` are here because a roster carries player names and ids, not merely who is in it.
 */
const ROOM_CHANGING_TYPES = new Set([
  'join_lobby', 'add_local_player', 'remove_player', 'set_player_name', 'swap_players',
  'start_match', 'rematch_vote', 'leave_match', 'spectate', 'reconnect',
  'activate_devices', 'deactivate_device', 'scorer_pair', 'scorer_hello', 'scorer_unpair', 'scorer_name',
  'media_ready', 'media_leave', 'media_join',
]);

// ============================================================
// Handlers
// ============================================================

function handleCreateLobby(ws: WebSocket, msg: any): void {
  if (!canCreateLobby()) {
    send(ws, { type: 'error', message: 'Server is full, try again later' });
    return;
  }

  const lobby = createLobby();
  lobby.isLocal = msg.isLocal !== false;
  const client = getClient(ws);
  if (client) {
    client.lobbyId = lobby.id;
    lobby.hostSessionId = client.sessionId;
    // The host chair before there is a player to sit in it: a lobby is created empty, and a reload
    // in that gap must still come back as its creator.
    sendResume(ws, { lobbyId: lobby.id }, claimSeat(lobby.id, client, { playerId: null, host: true }));
  }

  generateInviteCode(lobby.id);
  send(ws, lobbyMessage(lobby, { host: true }));
}

function handleJoinLobby(ws: WebSocket, msg: any): void {
  const lobby = msg.lobbyId
    ? getLobby(msg.lobbyId)
    : findLobbyByInviteCode(msg.inviteCode);

  if (!lobby) {
    send(ws, { type: 'error', message: 'Lobby not found' });
    return;
  }

  if (lobby.players.length >= 2 || lobby.remoteConnected) {
    send(ws, { type: 'error', message: lobby.players.length >= 2 ? 'Lobby is full' : 'Another user is already in this lobby' });
    return;
  }

  // Associate client with lobby — player is added manually via add_local_player
  const client = getClient(ws);
  if (client) {
    client.lobbyId = lobby.id;
    // Mark opponent as connected for the creator
    if (client.sessionId !== lobby.hostSessionId) {
      lobby.remoteConnected = true;
    }
    const host = client.sessionId === lobby.hostSessionId;
    sendResume(ws, { lobbyId: lobby.id }, claimSeat(lobby.id, client, { playerId: null, host }));
  }

  // Send direct response to joining client (in case not yet in clients map)
  send(ws, lobbyMessage(lobby, { host: client?.sessionId === lobby.hostSessionId }));
  broadcastToLobby(lobby.id, lobbyMessage(lobby), ws);
}

function handleAddLocalPlayer(ws: WebSocket, msg: any): void {
  const seated = seatedInLobby(ws);
  if (!seated) return;
  const { client } = seated;

  const name = sanitizeName(msg.playerName);
  if (!name) {
    send(ws, { type: 'error', message: 'Invalid player name (1-20 characters)' });
    return;
  }

  const lobby = getLobby(seated.lobbyId);
  if (!lobby) {
    send(ws, { type: 'error', message: 'Lobby not found' });
    return;
  }

  // Online: each client can only add 1 player
  if (!lobby.isLocal && lobby.players.some((p) => p.sessionId === client.sessionId)) {
    send(ws, { type: 'error', message: 'You have already added a player' });
    return;
  }

  const player = {
    id: generatePlayerId(),
    name,
    sessionId: client.sessionId,
  };

  const updated = addPlayerToLobby(lobby.id, player);
  if (!updated) {
    send(ws, { type: 'error', message: 'Lobby is full' });
    return;
  }

  // Track which player this client owns
  client.playerId = player.id;

  // Set host player if this is the first player in an online lobby
  if (!lobby.hostPlayerId && !lobby.isLocal) {
    lobby.hostPlayerId = player.id;
  }

  // The seat this connection already holds in the lobby, now with a player on it. A local host adds
  // two and keeps one seat: they hold every player, so any one of them proves the claim.
  const host = client.sessionId === lobby.hostSessionId;
  sendResume(ws, { lobbyId: lobby.id }, claimSeat(lobby.id, client, { playerId: player.id, host }));

  // Everyone sees the lobby; only this connection is told which player is its own — and in a local
  // match, where one user holds them all, that question has no answer.
  broadcastToLobby(lobby.id, lobbyMessage(lobby));
  send(ws, lobbyMessage(lobby, { playerId: lobby.isLocal ? undefined : player.id, host }));
}

function handleRemovePlayer(ws: WebSocket, msg: any): void {
  const req = requireLobby(ws);
  if (!req) return;
  const { client, lobby } = req;

  const player = lobby.players.find((p) => p.id === msg.playerId);
  if (!player) return;

  // Only allow removing your own session's player (local lobbies: one user controls all)
  if (!lobby.isLocal && player.sessionId !== client.sessionId) {
    send(ws, { type: 'error', message: 'You can only remove your own player' });
    return;
  }

  client.playerId = null;
  // The seat outlives the player on it. Left as it was, a reload would come back asking for somebody
  // who is no longer in the lobby.
  const held = heldSeat(lobby.id, client.sessionId);
  if (held && held.seat.playerId === msg.playerId) updateSeat(lobby.id, held.token, { playerId: null });
  removePlayerFromLobby(lobby.id, msg.playerId);
  broadcastToLobby(lobby.id, lobbyMessage(lobby));
}

function handleUpdateSettings(ws: WebSocket, msg: any): void {
  const req = requireLobby(ws);
  if (!req) return;
  const { client, lobby } = req;

  // Only the host session can update settings
  if (client.sessionId !== lobby.hostSessionId) {
    send(ws, { type: 'error', message: 'Only the match creator can change settings' });
    return;
  }

  const validated = validateSettings(msg.settings, lobby.settings);
  if (!validated) {
    send(ws, { type: 'error', message: 'Invalid settings' });
    return;
  }

  lobby.settings = validated;
  broadcastToLobby(lobby.id, lobbyMessage(lobby));
}

function handleSetPlayerName(ws: WebSocket, msg: any): void {
  const req = requireLobby(ws);
  if (!req) return;
  const { client, lobby } = req;

  const player = lobby.players.find((p) => p.id === msg.playerId);
  if (!player) return;

  // Only allow renaming your own session's player (local lobbies: one user controls all)
  if (!lobby.isLocal && player.sessionId !== client.sessionId) {
    send(ws, { type: 'error', message: 'You can only rename your own player' });
    return;
  }

  const name = sanitizeName(msg.name);
  if (!name) {
    send(ws, { type: 'error', message: 'Invalid player name (1-20 characters)' });
    return;
  }

  player.name = name;
  broadcastToLobby(lobby.id, lobbyMessage(lobby));
}

function handleStartMatch(ws: WebSocket, msg: any): void {
  const seated = seatedInLobby(ws);
  if (!seated) return;
  const { client } = seated;

  const lobby = getLobby(seated.lobbyId);
  if (!lobby) {
    send(ws, { type: 'error', message: 'Lobby not found' });
    return;
  }

  // Only the host can start the match (local lobbies: anyone can)
  if (!lobby.isLocal && client.sessionId !== lobby.hostSessionId) {
    send(ws, { type: 'error', message: 'Only the match creator can start the match' });
    return;
  }

  if (!canCreateMatch()) {
    send(ws, { type: 'error', message: 'Server is full, try again later' });
    return;
  }


  if (lobby.players.length < 1) {
    send(ws, { type: 'error', message: 'Need at least one player to start' });
    return;
  }

  const match = createMatch(lobby);
  startMediaForMatch(match);

  // Update all lobby clients to match
  for (const [w, c] of allClients()) {
    if (c.lobbyId === lobby.id) {
      c.matchId = match.id;
      c.lobbyId = null;
      // Same seat, new room id. A spectator carried along holds none and is told nothing.
      const held = heldSeat(match.id, c.sessionId);
      if (held) sendResume(w, { matchId: match.id }, held.token);
    }
  }

  broadcastToMatch(match.id, matchMessage('match_started', match));
  // The one push a scoring device cannot do without: it is what starts a camera that powered itself
  // down between matches. A device only ever learns it is wanted from `scorer_state`.
  publishScorerStateFor(devicesScoringInto(match.id));
}

function handleAddDart(ws: WebSocket, msg: any): void {
  const req = requireMatch(ws);
  if (!req) return;
  const { client, match } = req;

  const dart = validateDartThrow(msg.dart);
  if (!dart) { send(ws, { type: 'error', message: 'Invalid dart coordinates' }); return; }

  const playerId = match.isLocal ? match.players[match.currentPlayerIndex].id : client.playerId;
  if (!playerId) { send(ws, { type: 'error', message: 'No player associated' }); return; }
  if (!match.isLocal && playerId !== client.playerId) {
    send(ws, { type: 'error', message: 'You can only throw darts for your own player' });
    return;
  }

  const result = addDartToMatch(match, playerId, dart);
  if (!result.success) { send(ws, { type: 'error', message: result.error }); return; }

  commitScoredMatch(result.match);
}

function handleUndoDart(ws: WebSocket, _msg: any): void {
  const req = requireMatch(ws);
  if (!req) return;
  const { client, match } = req;

  const cv = match.currentVisit;
  if (!cv || cv.darts.length === 0) { send(ws, { type: 'error', message: 'No darts to undo' }); return; }
  if (!match.isLocal && cv.playerId !== client.playerId) {
    send(ws, { type: 'error', message: 'You can only undo your own darts' });
    return;
  }

  const result = undoDartFromMatch(match);
  if (!result.success) { send(ws, { type: 'error', message: result.error }); return; }

  commitScoredMatch(result.match);
}

function handleSubmitVisit(ws: WebSocket, _msg: any): void {
  const req = requireMatch(ws);
  if (!req) return;
  const { client, match } = req;

  const cv = match.currentVisit;
  if (cv && !match.isLocal && cv.playerId !== client.playerId) {
    send(ws, { type: 'error', message: 'You can only submit your own visit' });
    return;
  }

  const submitResult = submitVisitToMatch(match);
  if (!submitResult.success) { send(ws, { type: 'error', message: submitResult.error }); return; }

  commitScoredMatch(submitResult.match);
}

function handleLeaveMatch(ws: WebSocket, _msg: any): void {
  handleClientLeave(ws);
}

/**
 * Called when a client explicitly leaves or disconnects.
 */
export function handleClientLeave(ws: WebSocket): void {
  const client = getClient(ws);
  if (!client) return;

  if (client.isSpectator) {
    leaveAsSpectator(client);
    return;
  }

  // Leaving concedes a match and can abandon a lobby, so it is an act on the room like any other and
  // asks the same question: does this connection hold the place? One whose place was taken over does
  // not, and drops what it thought it had without touching anything. That also covers the disconnect
  // grace — a socket that closed and was replaced by a reload is no longer the occupant, so its
  // deferred leave cannot walk the returning tab out of the match.
  if (seatedInMatch(ws)) {
    leaveMatch(ws, client);
    return;
  }

  if (seatedInLobby(ws)) {
    leaveLobby(ws, client);
    return;
  }

  client.lobbyId = null;
  client.matchId = null;
  client.playerId = null;
}

function leaveAsSpectator(client: Client): void {
  client.isSpectator = false;
  client.lobbyId = null;
  client.matchId = null;
}

/**
 * A participant leaving a match, whether by pressing the button or by dropping off for good.
 *
 * Leaving is final. The player is recorded as departed, which bars them from reconnecting, and it
 * stands as their answer to a re-match: **walking out is a decline.** That is what makes the answer
 * always converge — there is no way to leave the question open by disappearing.
 */
function leaveMatch(_ws: WebSocket, client: Client): void {
  // Captured up front: below, this client's own `matchId` is cleared, and its devices are found
  // through it.
  const devices = devicesScoringInto(client.matchId!);
  // Final means the tab cannot come back either. `departed` says the same thing for the player, and
  // both are wanted: one is about who, the other about the connection holding the place.
  revokeSeat(client.matchId!, client.sessionId);
  const match = getMatch(client.matchId!);
  if (match) {
    if (client.playerId) {
      if (!match.departed.includes(client.playerId)) match.departed.push(client.playerId);
      match.rematchVotes[client.playerId] = 'declined';
    }

    if (match.status === 'in_progress') {
      // A local match is one user's, so their leaving cancels it: no winner. An online match has an
      // opponent still standing, and they take it.
      const winnerId = !match.isLocal && match.players.length === 2
        ? match.players.find((p) => p.id !== client.playerId)?.id ?? null
        : null;
      endMatch(match, winnerId);
    }
    broadcastToMatch(match.id, matchMessage('match_finished', match));
  }
  client.matchId = null;
  client.playerId = null;
  publishScorerStateFor(devices);
}

/**
 * A match is over: record how, and start its summary clock.
 *
 * Every route to a finished match goes through here, so every finished match has a deadline and none
 * can sit on the server unfinished.
 */
function endMatch(match: MatchState, winnerId: string | null): void {
  match.status = 'finished';
  match.winnerId = winnerId;
  match.finishedAt = Date.now();
  touch(match, SUMMARY_TTL_MS);
  dropScoringSessions(match.id);
  finishMediaForMatch(match.id);
}

function leaveLobby(ws: WebSocket, client: Client): void {
  revokeSeat(client.lobbyId!, client.sessionId);
  const lobby = getLobby(client.lobbyId!);
  if (!lobby) {
    client.lobbyId = null;
    return;
  }

  if (client.sessionId === lobby.hostSessionId) {
    // Host left → abandon lobby, kick everyone
    for (const [otherWs, otherClient] of allClients()) {
      if (otherWs !== ws && otherClient.lobbyId === lobby.id) {
        send(otherWs, { type: 'lobby_abandoned' });
        otherClient.lobbyId = null;
        otherClient.playerId = null;
      }
    }
    deleteLobby(lobby.id);
  } else {
    // Non-host left: clear lobbyId before broadcasting so leaver is excluded
    const leavingPlayerId = client.playerId;
    client.lobbyId = null;
    client.playerId = null;
    lobby.remoteConnected = false;
    if (leavingPlayerId) {
      removePlayerFromLobby(lobby.id, leavingPlayerId);
    }
    generateInviteCode(lobby.id);
    broadcastToLobby(lobby.id, lobbyMessage(lobby));
    return;
  }

  client.lobbyId = null;
  client.playerId = null;
}

function handleSpectate(ws: WebSocket, msg: any): void {
  const id = msg.id as string;
  if (!id) {
    send(ws, { type: 'error', message: 'Invalid spectate ID' });
    return;
  }

  // Try to find as lobby first, then as match
  const lobby = getLobby(id);
  if (lobby) {
    const client = getClient(ws);
    if (client) {
      client.lobbyId = lobby.id;
      client.isSpectator = true;
    }
    send(ws, lobbyMessage(lobby, { host: false }));
    return;
  }

  const match = getMatch(id);
  if (match) {
    const client = getClient(ws);
    if (client) {
      client.matchId = match.id;
      client.isSpectator = true;
    }
    send(ws, matchMessage('match_state', match));
    return;
  }

  send(ws, { type: 'error', message: 'Lobby or match not found' });
}

/**
 * A reloaded tab claiming its place back.
 *
 * **The seat decides what is resumed, and the message only says which room.** A reload arrives on a
 * new socket under a new session id, so there is nothing about the connection left to recognise —
 * which is exactly why this used to be forgeable: it named a player and the server took its word,
 * and a player id is in every match broadcast the room sends, spectators included. The token is the
 * one thing a watcher was never handed.
 */
function handleReconnect(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
  if (!client) {
    send(ws, { type: 'error', message: 'Session not found' });
    return;
  }

  const roomId: unknown = msg.lobbyId ?? msg.matchId;
  if (typeof roomId !== 'string' || !roomId) {
    send(ws, { type: 'error', message: 'No lobby or match ID provided for reconnect' });
    return;
  }

  const redeemed = redeemSeat(roomId, msg.token, client.sessionId);
  if (!redeemed) {
    send(ws, { type: 'error', message: 'Cannot resume this session' });
    return;
  }
  // A place has one occupant. Whoever was in it is out of the room before the newcomer is admitted,
  // so a duplicated tab replaces the original rather than joining it.
  if (redeemed.takenFrom) releaseTakenSeat(redeemed.takenFrom, roomId);

  if (msg.lobbyId) reconnectToLobby(ws, client, msg.lobbyId, redeemed.seat);
  else reconnectToMatch(ws, client, roomId, redeemed.seat);
}

/** Page reload during the lobby phase. */
function reconnectToLobby(ws: WebSocket, client: Client, lobbyId: string, seat: Seat): void {
  // Cancel any pending disconnect for this player (page reload recovery)
  cancelDisconnect(seat.playerId ? `lobby:${lobbyId}:${seat.playerId}` : `lobby:${lobbyId}:`);

  const lobby = getLobby(lobbyId);
  if (!lobby) {
    send(ws, { type: 'error', message: 'Lobby not found' });
    return;
  }

  client.lobbyId = lobby.id;
  client.playerId = null;
  // Whatever this connection was before the reload, the seat is what it is now — and a seat is only
  // ever a participant's.
  client.isSpectator = false;
  if (seat.host) lobby.hostSessionId = client.sessionId;

  // A seat with no player is an ordinary state, not a failure: a lobby taken before anybody was
  // added to it, or one whose player has since been removed.
  const player = seat.playerId ? lobby.players.find((p) => p.id === seat.playerId) : undefined;
  if (player) {
    // A page reload gives a new session; the player it belongs to follows it.
    player.sessionId = client.sessionId;
    client.playerId = player.id;
  }

  send(ws, lobbyMessage(lobby, { playerId: lobby.isLocal ? undefined : player?.id, host: seat.host }));
}

/** Page reload during the match. */
function reconnectToMatch(ws: WebSocket, client: Client, matchId: string, seat: Seat): void {
  cancelDisconnect(`match:${matchId}:${seat.playerId}`);

  const match = getMatch(matchId);
  if (!match) {
    send(ws, { type: 'error', message: 'Match not found' });
    return;
  }
  const player = seat.playerId ? match.players.find((p) => p.id === seat.playerId) : undefined;
  if (!player) {
    send(ws, { type: 'error', message: 'Player not found in match' });
    return;
  }
  if (match.isLocal) cancelDisconnectsForMatch(match.id);
  // Leaving is final: a player who walked out does not come back, however they walked out.
  if (match.departed.includes(player.id)) {
    send(ws, { type: 'error', message: 'You have left this match' });
    return;
  }

  player.sessionId = client.sessionId;
  client.lobbyId = null;
  client.matchId = match.id;
  client.playerId = player.id;
  client.isSpectator = false;
  // The one message that tells a connection which player is its own: a reloaded tab cannot work that
  // out from the match, and a local match is the same "no answer" it is everywhere else.
  send(ws, matchMessage('match_state', match, match.isLocal ? undefined : player.id));
}

/**
 * A player accepting or withdrawing a re-match. Everyone accepting starts one immediately.
 *
 * The vote lives on the match, so both sides watch each other's toggle through the ordinary state
 * broadcast rather than through a mechanism of its own.
 */
function handleRematchVote(ws: WebSocket, msg: any): void {
  const seated = seatedInMatch(ws);
  if (!seated) return;
  const { client } = seated;

  const match = getMatch(seated.matchId);
  if (!match || match.status !== 'finished') return;

  const player = match.players.find((p) => p.id === msg.playerId);
  if (!player) return;
  // You may answer for your own players — which in a local match is all of them.
  if (!match.isLocal && player.sessionId !== client.sessionId) {
    send(ws, { type: 'error', message: 'You can only answer for your own player' });
    return;
  }
  // A player who has left has answered, by leaving.
  if (match.departed.includes(player.id)) return;

  if (msg.answer === 'accepted' || msg.answer === 'declined') {
    match.rematchVotes[player.id] = msg.answer;
  } else {
    delete match.rematchVotes[player.id];
  }

  resolveRematch(ws, match);
}

/**
 * Where a re-match vote lands.
 *
 * Everyone accepting starts one. Anything short of that only publishes the state: a decline settles
 * the question, but the match still lives out its summary — the two minutes are for reading the
 * result, and every match ends at its deadline whatever was voted.
 */
function resolveRematch(ws: WebSocket | null, match: MatchState): void {
  const answers = match.players.map((p) => match.rematchVotes[p.id]);
  const unanimous = answers.length > 0 && answers.every((a) => a === 'accepted');

  if (!unanimous) {
    broadcastToMatch(match.id, matchMessage('match_state', match));
    return;
  }

  if (!canCreateMatch()) {
    if (ws) send(ws, { type: 'error', message: 'Server is full, try again later' });
    return;
  }

  // Everyone is in. The re-match is an ordinary new match; the only thing carried across is who is
  // watching — spectators included, so an audience is not left behind on the finished one.
  const rematch = createRematch(match);
  startMediaForMatch(rematch);
  for (const [otherWs, other] of allClients()) {
    if (other.matchId !== match.id) continue;
    other.matchId = rematch.id;
    // The same seat under a new room id, so a tab reloaded into the re-match still knows itself.
    const held = heldSeat(rematch.id, other.sessionId);
    if (held) sendResume(otherWs, { matchId: rematch.id }, held.token);
  }
  broadcastToMatch(rematch.id, matchMessage('match_started', rematch));
  // Looked up on the new match, because the clients have already been moved onto it.
  publishScorerStateFor(devicesScoringInto(rematch.id));
}

function handleSwapPlayers(ws: WebSocket, _msg: any): void {
  const req = requireLobby(ws);
  if (!req) return;
  const { client, lobby } = req;

  // Only the host can reorder players
  if (client.sessionId !== lobby.hostSessionId && !lobby.isLocal) {
    send(ws, { type: 'error', message: 'Only the match creator can change player order' });
    return;
  }

  if (!swapLobbyPlayers(lobby.id)) {
    send(ws, { type: 'error', message: 'Need two players to swap order' });
    return;
  }

  broadcastToLobby(lobby.id, lobbyMessage(lobby));
}
