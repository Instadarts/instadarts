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
import { createLobby, getLobby, addPlayerToLobby, removePlayerFromLobby, createMatch, createRematch, getMatch, findLobbyByInviteCode, deleteLobby, deleteMatch, maxPlayersFor, movePlayerInLobby } from './store';
import { generatePlayerId } from './player';
import { addDartToMatch, undoDartFromMatch, submitVisitToMatch, nextActiveIndex } from './match';
import { generateInviteCode } from './invite';
import { nameIsTaken, sanitizeName, validateSettings, validateDartThrow } from './validation';
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
import { grantSeat, heldSeat, holdsSeat, redeemSeat, revokeSeat, seatedPlayerIds, updateSeat, type Seat } from './seats';
import { allModes, describeMode, getMode } from './modes/types';
import { effectiveMaxPlayers } from '../shared/settings';
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
  usersInLobby,
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
  const pid = client.playerIds[0] ?? '';
  if (client.lobbyId && pid) return `lobby:${client.lobbyId}:${pid}`;
  if (client.lobbyId) return `lobby:${client.lobbyId}:`;
  if (client.matchId && pid) return `match:${client.matchId}:${pid}`;
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
  client.playerIds = [];
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
  // by the players added on that seat.
  if (held.seat.playerIds.length === 0 && seat.playerIds.length > 0) {
    updateSeat(roomId, held.token, { playerIds: [...seat.playerIds] });
  }
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
    case 'reorder_player':
      handleReorderPlayer(ws, msg);
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
      client.playerIds = [];
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
      client.playerIds = [];
      client.isSpectator = false;
    }
    deleteLobby(lobby.id);
    publishMediaForRoom(lobby.id);
  },
});

/** Message types that count as input for the idle timeout. */
const INPUT_TYPES = new Set([
  'create_lobby', 'join_lobby', 'add_local_player', 'remove_player', 'set_player_name',
  'update_settings', 'reorder_player', 'start_match',
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
  'join_lobby', 'add_local_player', 'remove_player', 'set_player_name', 'reorder_player',
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
  // Absent means no, so a bare `create_lobby` is the closed one — which is the button most people
  // press, and the safer default besides.
  lobby.acceptsJoins = msg.acceptsJoins === true;
  const client = getClient(ws);
  if (client) {
    client.lobbyId = lobby.id;
    client.playerIds = [];
    lobby.hostSessionId = client.sessionId;
    // The host chair before there is a player to sit in it: a lobby is created empty, and a reload
    // in that gap must still come back as its creator.
    sendResume(ws, { lobbyId: lobby.id }, claimSeat(lobby.id, client, { playerIds: [], host: true }));
  }

  // A closed lobby is minted without a code at all. That is the enforcement, not a decoration: a
  // code nobody has cannot be presented, and `findLobbyByInviteCode` has nothing to match.
  if (lobby.acceptsJoins) generateInviteCode(lobby.id);
  send(ws, lobbyMessage(lobby, { playerIds: [], host: true }));
}

function handleJoinLobby(ws: WebSocket, msg: any): void {
  const lobby = msg.lobbyId
    ? getLobby(msg.lobbyId)
    : findLobbyByInviteCode(msg.inviteCode);

  if (!lobby) {
    send(ws, { type: 'error', message: 'Lobby not found' });
    return;
  }

  // Asked before anything about capacity, because a closed lobby is not a lobby you were nearly
  // admitted to. It is minted without a code, so the only way to be here is by naming its id — and
  // a lobby id is public: it is the spectate URL.
  if (!lobby.acceptsJoins) {
    send(ws, { type: 'error', message: 'This lobby is not open to joins' });
    return;
  }

  // A user brings at least one player, so the player cap caps them too: somebody who could never
  // take a place is refused rather than admitted to sit and watch the Add button stay dead.
  const max = maxPlayersFor(lobby.settings.mode);
  if (lobby.players.length >= max || usersInLobby(lobby.id) >= max) {
    send(ws, { type: 'error', message: 'Lobby is full' });
    return;
  }

  // Associate client with lobby — players are added via add_local_player
  const client = getClient(ws);
  if (client) {
    // A connection already in this lobby is re-announcing itself rather than arriving, and its
    // players are whatever its **seat** says they are — the seat outranks the connection here as
    // everywhere else. Clearing the list unconditionally orphaned them: still on the roster, owned
    // by nobody, and carried into the match as ghosts nobody could throw for.
    const held = heldSeat(lobby.id, client.sessionId);
    const mine = (held?.seat.playerIds ?? []).filter((id) => lobby.players.some((p) => p.id === id));
    client.lobbyId = lobby.id;
    client.playerIds = mine;
    const host = client.sessionId === lobby.hostSessionId;
    if (held) updateSeat(lobby.id, held.token, { playerIds: mine });
    sendResume(ws, { lobbyId: lobby.id }, claimSeat(lobby.id, client, { playerIds: mine, host }));
  }

  send(ws, lobbyMessage(lobby, {
    playerIds: client?.playerIds ?? [],
    host: client?.sessionId === lobby.hostSessionId,
  }));
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

  if (lobby.players.length >= maxPlayersFor(lobby.settings.mode)) {
    send(ws, { type: 'error', message: 'Lobby is full' });
    return;
  }

  if (nameIsTaken(lobby.players, name)) {
    send(ws, { type: 'error', message: 'That name is already taken' });
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

  client.playerIds.push(player.id);

  // The seat this connection already holds in the lobby, now with its players on it.
  const host = client.sessionId === lobby.hostSessionId;
  const held = heldSeat(lobby.id, client.sessionId);
  if (held) {
    updateSeat(lobby.id, held.token, { playerIds: [...client.playerIds], host });
    sendResume(ws, { lobbyId: lobby.id }, held.token);
  } else {
    sendResume(ws, { lobbyId: lobby.id }, claimSeat(lobby.id, client, { playerIds: [...client.playerIds], host }));
  }

  // Everyone sees the lobby; only this connection is told which players are its own. One user
  // holding every player is not a reason to withhold the answer — the answer is all of them.
  broadcastToLobby(lobby.id, lobbyMessage(lobby));
  send(ws, lobbyMessage(lobby, { playerIds: client.playerIds, host }));
}

/**
 * Take a player off the roster — your own, or anybody's if you are the host.
 *
 * The host's power over the roster is a **kick**, and what makes it more than an edit of one's own
 * list is *where the removal lands*: a player is held by its owner's connection and its owner's
 * seat, never by the connection doing the removing. Editing the remover's lists left the owner
 * holding an id for somebody no longer in the room — which is precisely what a ghost participant is
 * made of, and what `seatedPlayerIds` now backstops at the freeze point.
 */
function handleRemovePlayer(ws: WebSocket, msg: any): void {
  const req = requireLobby(ws);
  if (!req) return;
  const { client, lobby } = req;

  const player = lobby.players.find((p) => p.id === msg.playerId);
  if (!player) return;

  // A player is yours to take off, or you are the host and it is a kick. A lobby held by one user
  // needs no case of its own: that user owns every player in it and is its host besides.
  const removerIsHost = client.sessionId === lobby.hostSessionId;
  if (player.sessionId !== client.sessionId && !removerIsHost) {
    send(ws, { type: 'error', message: 'You can only remove your own player' });
    return;
  }

  // Whoever actually holds this player. The same connection as the remover in every case but a
  // kick, which is the case that used to go wrong.
  const ownerWs = player.sessionId ? findSessionSocket(player.sessionId) : null;
  const owner = ownerWs ? getClient(ownerWs) : null;
  if (owner) owner.playerIds = owner.playerIds.filter((id) => id !== player.id);
  // Updated from the seat's own list rather than from the client's, and even when no live
  // connection answers for the session: a tab inside its disconnect grace holds no usable client
  // record but still holds its place, and that seat is what its reload comes back on.
  const held = player.sessionId ? heldSeat(lobby.id, player.sessionId) : null;
  if (held) {
    updateSeat(lobby.id, held.token, {
      playerIds: held.seat.playerIds.filter((id) => id !== player.id),
    });
  }

  removePlayerFromLobby(lobby.id, player.id);

  broadcastToLobby(lobby.id, lobbyMessage(lobby));
  // The owner is told what it has left rather than left to infer it from a roster that names
  // nobody's players. Without this a kicked user only ever learns it by subtraction.
  if (ownerWs && owner) {
    send(ownerWs, lobbyMessage(lobby, {
      playerIds: owner.playerIds,
      host: owner.sessionId === lobby.hostSessionId,
      spectator: owner.isSpectator,
    }));
  }
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

  const mode = getMode(validated.mode);
  if (mode?.maxPlayers && lobby.players.length > mode.maxPlayers) {
    send(ws, { type: 'error', message: `${mode.label} takes at most ${mode.maxPlayers} players` });
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

  // Renaming is your own players only — the host's power over the roster stops at removing.
  if (player.sessionId !== client.sessionId) {
    send(ws, { type: 'error', message: 'You can only rename your own player' });
    return;
  }

  const name = sanitizeName(msg.name);
  if (!name) {
    send(ws, { type: 'error', message: 'Invalid player name (1-20 characters)' });
    return;
  }
  // Excluding the player being renamed, so renaming it to what it is already called is a no-op
  // rather than a refusal.
  if (nameIsTaken(lobby.players, name, player.id)) {
    send(ws, { type: 'error', message: 'That name is already taken' });
    return;
  }

  player.name = name;
  broadcastToLobby(lobby.id, lobbyMessage(lobby));
}

function handleStartMatch(ws: WebSocket, _msg: any): void {
  const seated = seatedInLobby(ws);
  if (!seated) return;
  const { client } = seated;

  const lobby = getLobby(seated.lobbyId);
  if (!lobby) {
    send(ws, { type: 'error', message: 'Lobby not found' });
    return;
  }

  // Only the host starts the match. The one user of a lobby nobody joined is its host, so that
  // costs them nothing.
  if (client.sessionId !== lobby.hostSessionId) {
    send(ws, { type: 'error', message: 'Only the match creator can start the match' });
    return;
  }

  if (!canCreateMatch()) {
    send(ws, { type: 'error', message: 'Server is full, try again later' });
    return;
  }

  // Nothing unowned goes into a match. A player belongs to the seat that holds it, and the rosters
  // go immutable at `createMatch` — so this is the last moment an orphan can be taken out, and it
  // runs before the counts below so they see the roster that will actually play.
  const seatedIds = seatedPlayerIds(lobby.id);
  for (const player of [...lobby.players]) {
    if (!seatedIds.has(player.id)) removePlayerFromLobby(lobby.id, player.id);
  }

  const mode = getMode(lobby.settings.mode);
  if (mode?.maxPlayers && lobby.players.length > mode.maxPlayers) {
    send(ws, { type: 'error', message: `${mode.label} takes at most ${mode.maxPlayers} players` });
    return;
  }

  // One player is a practice session rather than a mistake, and it is the same rule whether or not
  // anybody else was invited.
  if (lobby.players.length < 1) {
    send(ws, { type: 'error', message: 'Need at least one player to start' });
    return;
  }

  // Nobody sits in a match without a player in it. A user who watched the lobby without adding one
  // becomes what it already was in practice — a spectator — and gives up its seat, which is what
  // keeps it out of every guard that asks whether a connection holds a place.
  //
  // Measured against the reconciled roster and not against the connection's own list, so a client
  // holding only ids that have just gone away is demoted with the rest.
  for (const [, c] of allClients()) {
    if (c.lobbyId !== lobby.id || c.isSpectator || c.deviceId) continue;
    c.playerIds = c.playerIds.filter((id) => lobby.players.some((p) => p.id === id));
    if (c.playerIds.length > 0) continue;
    revokeSeat(lobby.id, c.sessionId);
    c.isSpectator = true;
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
      send(w, matchMessage('match_started', match, {
        playerIds: c.playerIds,
        spectator: c.isSpectator,
      }));
    }
  }

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

  const current = match.players[match.currentPlayerIndex];
  if (!current) { send(ws, { type: 'error', message: 'No current player' }); return; }
  if (!client.playerIds.includes(current.id)) {
    send(ws, { type: 'error', message: 'You can only throw darts for your own player' });
    return;
  }

  const result = addDartToMatch(match, current.id, dart);
  if (!result.success) { send(ws, { type: 'error', message: result.error }); return; }

  commitScoredMatch(result.match);
}

function handleUndoDart(ws: WebSocket, _msg: any): void {
  const req = requireMatch(ws);
  if (!req) return;
  const { client, match } = req;

  const cv = match.currentVisit;
  if (!cv || cv.darts.length === 0) { send(ws, { type: 'error', message: 'No darts to undo' }); return; }
  if (!client.playerIds.includes(cv.playerId)) {
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
  if (cv && !client.playerIds.includes(cv.playerId)) {
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
  client.playerIds = [];
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
    for (const pid of client.playerIds) {
      if (!match.departed.includes(pid)) match.departed.push(pid);
      match.rematchVotes[pid] = 'declined';
    }

    const remaining = match.players.filter((p) => !match.departed.includes(p.id));

    if (match.status === 'in_progress') {
      // Nobody left to play it. A user holding every player takes them all with it, which is how a
      // one-user match ends up here and why that needs no case of its own.
      if (remaining.length === 0) {
        endMatch(match, null);
        broadcastToMatch(match.id, matchMessage('match_finished', match));
      } else if (remaining.length === 1) {
        endMatch(match, remaining[0].id);
        broadcastToMatch(match.id, matchMessage('match_finished', match));
      } else {
        // The match continues!
        // If the leaver held the current visit, drop currentVisit and advance currentPlayerIndex past them
        const current = match.players[match.currentPlayerIndex];
        if (current && match.departed.includes(current.id)) {
          match.currentVisit = undefined;
          match.currentPlayerIndex = nextActiveIndex(match, match.currentPlayerIndex);
        }
        broadcastToMatch(match.id, matchMessage('match_state', match));
      }
    } else {
      broadcastToMatch(match.id, matchMessage('match_finished', match));
    }
  }
  client.matchId = null;
  client.playerIds = [];
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
    client.playerIds = [];
    return;
  }

  if (client.sessionId === lobby.hostSessionId) {
    // Host left → abandon lobby, kick everyone
    for (const [otherWs, otherClient] of allClients()) {
      if (otherWs !== ws && otherClient.lobbyId === lobby.id) {
        send(otherWs, { type: 'lobby_abandoned' });
        otherClient.lobbyId = null;
        otherClient.playerIds = [];
      }
    }
    deleteLobby(lobby.id);
  } else {
    // Non-host left: clear lobbyId before broadcasting so leaver is excluded
    const leavingPlayerIds = [...client.playerIds];
    client.lobbyId = null;
    client.playerIds = [];
    for (const pid of leavingPlayerIds) {
      removePlayerFromLobby(lobby.id, pid);
    }
    // The code is retired once the last guest is gone, so a leaver cannot walk back into a lobby
    // that has emptied out. While others are still here it stays put: with n users, minting a new
    // one on every departure would strand everybody else's copy. Spectators do not count — watching
    // is not holding a place.
    const guestsRemain = [...allClients()].some(
      ([, c]) => c.lobbyId === lobby.id && c.sessionId !== lobby.hostSessionId && !c.deviceId && !c.isSpectator,
    );
    if (!guestsRemain && lobby.acceptsJoins) generateInviteCode(lobby.id);
    broadcastToLobby(lobby.id, lobbyMessage(lobby));
    return;
  }

  client.lobbyId = null;
  client.playerIds = [];
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
    send(ws, lobbyMessage(lobby, { host: false, spectator: true }));
    return;
  }

  const match = getMatch(id);
  if (match) {
    const client = getClient(ws);
    if (client) {
      client.matchId = match.id;
      client.isSpectator = true;
    }
    send(ws, matchMessage('match_state', match, { spectator: true }));
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
  cancelDisconnect(seat.playerIds[0] ? `lobby:${lobbyId}:${seat.playerIds[0]}` : `lobby:${lobbyId}:`);

  const lobby = getLobby(lobbyId);
  if (!lobby) {
    send(ws, { type: 'error', message: 'Lobby not found' });
    return;
  }

  client.lobbyId = lobby.id;
  client.playerIds = [];
  // Whatever this connection was before the reload, the seat is what it is now — and a seat is only
  // ever a participant's.
  client.isSpectator = false;
  if (seat.host) lobby.hostSessionId = client.sessionId;

  // A seat with no player is an ordinary state, not a failure: a lobby taken before anybody was
  // added to it, or one whose player has since been removed.
  for (const pid of seat.playerIds) {
    const player = lobby.players.find((p) => p.id === pid);
    if (player) {
      // A page reload gives a new session; the player it belongs to follows it.
      player.sessionId = client.sessionId;
      client.playerIds.push(player.id);
    }
  }

  send(ws, lobbyMessage(lobby, { playerIds: client.playerIds, host: seat.host }));
}

/** Page reload during the match. */
function reconnectToMatch(ws: WebSocket, client: Client, matchId: string, seat: Seat): void {
  if (seat.playerIds[0]) cancelDisconnect(`match:${matchId}:${seat.playerIds[0]}`);

  const match = getMatch(matchId);
  if (!match) {
    send(ws, { type: 'error', message: 'Match not found' });
    return;
  }

  if (seat.playerIds.length > 0 && seat.playerIds.every((id) => match.departed.includes(id))) {
    send(ws, { type: 'error', message: 'You have already left this match' });
    return;
  }


  client.lobbyId = null;
  client.matchId = match.id;
  client.playerIds = [];
  client.isSpectator = false;

  for (const pid of seat.playerIds) {
    const player = match.players.find((p) => p.id === pid);
    if (player) {
      player.sessionId = client.sessionId;
      client.playerIds.push(player.id);
    }
  }

  // The one message that tells a connection which players are its own: a reloaded tab cannot work
  // that out from a match that names nobody's owner.
  send(ws, matchMessage('match_state', match, {
    playerIds: client.playerIds,
    spectator: false,
  }));
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
  // You may answer for your own players — which for a user holding all of them is all of them.
  if (!client.playerIds.includes(player.id)) {
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
    send(otherWs, matchMessage('match_started', rematch, {
      playerIds: other.playerIds,
      spectator: other.isSpectator,
    }));
  }
  // Looked up on the new match, because the clients have already been moved onto it.
  publishScorerStateFor(devicesScoringInto(rematch.id));
}

function handleReorderPlayer(ws: WebSocket, msg: any): void {
  const req = requireLobby(ws);
  if (!req) return;
  const { client, lobby } = req;

  // Only the host reorders players — see `handleStartMatch` on why that costs a lone user nothing.
  if (client.sessionId !== lobby.hostSessionId) {
    send(ws, { type: 'error', message: 'Only the match creator can change player order' });
    return;
  }

  if (msg.direction !== 'up' && msg.direction !== 'down') return;
  if (typeof msg.playerId !== 'string') return;

  const moved = movePlayerInLobby(lobby.id, msg.playerId, msg.direction);
  if (!moved) return;

  broadcastToLobby(lobby.id, lobbyMessage(lobby));
}
