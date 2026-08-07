import type { WebSocket } from 'ws';
import type { ServerMessage } from '../shared/protocol';
import type { MatchState, Lobby } from '../shared/types';
import type { Client } from './types';
import { parseMessage, formatMessage } from '../shared/protocol';
import { createLobby, getLobby, addPlayerToLobby, removePlayerFromLobby, createMatch, createRematch, getMatch, findLobbyByInviteCode, updateMatch, deleteLobby, swapLobbyPlayers } from './store';
import { generatePlayerId } from './player';
import { addDartToMatch, undoDartFromMatch, submitVisitToMatch, viewOf } from './match';
import { generateInviteCode } from './invite';
import { sanitizeName, validateSettings, validateDartThrow, validateDeviceClaims, validateTips } from './validation';
import { checkRateLimit, checkTipsRateLimit, removeRateLimitBucket } from './rateLimit';
import { getScoringSession, dropScoringSessions } from './scoring/store';
import { canCreateLobby, canCreateMatch } from './concurrencyLimit';
import {
  claimDevice,
  createPairingCode,
  devicesForSession,
  ownerOf,
  redeemPairingCode,
  releaseDevice,
  releaseSession,
  setCameraActive,
  setDeviceName,
  unclaimDevice,
  verifyDevice,
} from './devices';

// ============================================================
// Client registry
// ============================================================

const clients = new Map<WebSocket, Client>();

// Pending disconnect timers for page reload recovery
const DISCONNECT_GRACE_MS = 3000;
const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>();

function disconnectKey(client: Client): string | null {
  if (client.lobbyId && client.playerId) return `lobby:${client.lobbyId}:${client.playerId}`;
  if (client.lobbyId) return `lobby:${client.lobbyId}:`;
  if (client.matchId && client.playerId) return `match:${client.matchId}:${client.playerId}`;
  return null;
}

export function scheduleDisconnect(ws: WebSocket, onTimeout: () => void): void {
  const client = clients.get(ws);
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
  clients.set(ws, client);
}

export function getClient(ws: WebSocket): Client | undefined {
  return clients.get(ws);
}

export function removeClient(ws: WebSocket): void {
  // Clean up rate limit bucket
  const client = clients.get(ws);
  if (client) {
    removeRateLimitBucket(client.playerId ?? '');
    releaseScoringState(client);
  }
  clients.delete(ws);
}

/** Whichever side of the pairing this connection was, let go of it. */
function releaseScoringState(client: Client): void {
  if (client.deviceId) {
    const owner = ownerOf(client.deviceId);
    deviceSockets.delete(client.deviceId);
    releaseDevice(client.deviceId);
    if (owner) publishDevicesState(owner);
    return;
  }
  for (const deviceId of releaseSession(client.sessionId)) {
    publishScorerState(deviceId);
  }
}

// ============================================================
// Broadcasting
// ============================================================

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(formatMessage(msg));
  }
}

function broadcastToLobby(lobbyId: string, msg: ServerMessage, excludeWs?: WebSocket): void {
  for (const [ws, client] of clients) {
    if (ws === excludeWs) continue;
    if (client.lobbyId === lobbyId || client.matchId === lobbyId) {
      send(ws, msg);
    }
  }
}

function broadcastToMatch(matchId: string, msg: ServerMessage): void {
  for (const [ws, client] of clients) {
    if (client.matchId === matchId) {
      send(ws, msg);
    }
  }
}

// ============================================================
// Request guards
// ============================================================

/** Validates that the client is playing in an active match. Returns client+match or null (error already sent). */
function requireMatch(ws: WebSocket): { client: Client; match: MatchState } | null {
  const client = clients.get(ws);
  if (!client?.matchId) return null;
  if (client.isSpectator) return null;
  const match = getMatch(client.matchId);
  if (!match) { send(ws, { type: 'error', message: 'Match not found' }); return null; }
  return { client, match };
}

/** Validates that the client is in a lobby. Returns client+lobby or null. Does NOT send errors for silent-return handlers. */
function requireLobby(ws: WebSocket): { client: Client; lobby: Lobby } | null {
  const client = clients.get(ws);
  if (!client?.lobbyId) return null;
  if (client.isSpectator) return null;
  const lobby = getLobby(client.lobbyId);
  if (!lobby) return null;
  return { client, lobby };
}

// ============================================================
// Message routing
// ============================================================

export function handleMessage(ws: WebSocket, raw: string): void {
  const client = clients.get(ws);

  const msg = parseMessage(raw);
  if (!msg) {
    send(ws, { type: 'error', message: 'Invalid message format' });
    return;
  }

  // Tips get their own budget. A camera on a fast phone publishes faster than a person clicks, and
  // one of the reports it would lose to the shared bucket is the empty one that ends the visit.
  if (msg.type === 'scorer_tips') {
    if (!client?.deviceId || !checkTipsRateLimit(client.deviceId)) return;
  } else if (!checkRateLimit(client?.sessionId ?? `anon_${Math.random()}`)) {
    send(ws, { type: 'error', message: 'Rate limit exceeded' });
    return;
  }

  // A connection is a frontend or a scoring device, never both. Keeping the two vocabularies apart
  // means a compromised scoring device cannot reach a single gameplay handler.
  const isScorerMessage = msg.type.startsWith('scorer_');
  if (client?.deviceId && !isScorerMessage) return;
  if (isScorerMessage && !client?.deviceId && msg.type !== 'scorer_pair' && msg.type !== 'scorer_hello') return;

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
    case 'scorer_pair':
      handleScorerPair(ws, msg);
      break;
    case 'scorer_hello':
      handleScorerHello(ws, msg);
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
    default:
      send(ws, { type: 'error', message: `Unknown message type: ${(msg as any).type}` });
  }
}

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
  const client = clients.get(ws);
  if (client) {
    client.lobbyId = lobby.id;
    lobby.hostSessionId = client.sessionId;
  }

  generateInviteCode(lobby.id);
  send(ws, { type: 'lobby_state', lobby: { ...lobby } });
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
  const client = clients.get(ws);
  if (client) {
    client.lobbyId = lobby.id;
    // Mark opponent as connected for the creator
    if (client.sessionId !== lobby.hostSessionId) {
      lobby.remoteConnected = true;
    }
  }

  // Send direct response to joining client (in case not yet in clients map)
  send(ws, { type: 'lobby_state', lobby: { ...lobby } });
  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } }, ws);
}

function handleAddLocalPlayer(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.lobbyId) return;
  if (client.isSpectator) return;

  const name = sanitizeName(msg.playerName);
  if (!name) {
    send(ws, { type: 'error', message: 'Invalid player name (1-20 characters)' });
    return;
  }

  const lobby = getLobby(client.lobbyId);
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

  // Broadcast to all; send yourPlayerId for online so client knows which player it owns
  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
  if (!lobby.isLocal) {
    send(ws, { type: 'lobby_state', lobby: { ...lobby }, yourPlayerId: player.id });
  } else {
    send(ws, { type: 'lobby_state', lobby: { ...lobby } });
  }
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
  removePlayerFromLobby(lobby.id, msg.playerId);
  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
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
  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
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
  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
}

function handleStartMatch(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.lobbyId) return;
  if (client.isSpectator) return;

  const lobby = getLobby(client.lobbyId);
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

  // Update all lobby clients to match
  for (const [w, c] of clients) {
    if (c.lobbyId === lobby.id) {
      c.matchId = match.id;
      c.lobbyId = null;
    }
  }

  broadcastToMatch(match.id, { type: 'match_started', match: { ...match }, view: viewOf(match) });
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
  const client = clients.get(ws);
  if (!client) return;

  if (client.isSpectator) {
    leaveAsSpectator(client);
    return;
  }

  if (client.matchId) {
    leaveMatch(ws, client);
    return;
  }

  if (client.lobbyId) {
    leaveLobby(ws, client);
  }
}

function leaveAsSpectator(client: Client): void {
  client.isSpectator = false;
  client.lobbyId = null;
  client.matchId = null;
}

/**
 * A participant leaving a match, whether by pressing the button or by dropping off for good.
 *
 * Leaving is final. The player is recorded as departed, which bars them from reconnecting and takes
 * the re-match off the table for everyone — the person who would have to agree to one has gone. That
 * holds for leaving a match that is already over, too: there is then nobody left to re-match with.
 */
function leaveMatch(_ws: WebSocket, client: Client): void {
  const match = getMatch(client.matchId!);
  if (match) {
    if (client.playerId && !match.departed.includes(client.playerId)) {
      match.departed.push(client.playerId);
    }
    // A departing player's vote goes with them.
    match.rematchVotes = match.rematchVotes.filter((id) => id !== client.playerId);

    if (match.status === 'in_progress') {
      match.status = 'finished';
      match.finishedAt = Date.now();
      // A local match is one user's, so their leaving cancels it: no winner. An online match has an
      // opponent still standing, and they take it.
      if (!match.isLocal && match.players.length === 2) {
        match.winnerId = match.players.find((p) => p.id !== client.playerId)?.id ?? null;
      }
    }
    broadcastToMatch(match.id, { type: 'match_finished', match: { ...match }, view: viewOf(match) });
  }
  client.matchId = null;
  client.playerId = null;
}

function leaveLobby(ws: WebSocket, client: Client): void {
  const lobby = getLobby(client.lobbyId!);
  if (!lobby) {
    client.lobbyId = null;
    return;
  }

  if (client.sessionId === lobby.hostSessionId) {
    // Host left → abandon lobby, kick everyone
    for (const [otherWs, otherClient] of clients) {
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
    broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
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
    const client = clients.get(ws);
    if (client) {
      client.lobbyId = lobby.id;
      client.isSpectator = true;
    }
    send(ws, { type: 'lobby_state', lobby: { ...lobby } });
    return;
  }

  const match = getMatch(id);
  if (match) {
    const client = clients.get(ws);
    if (client) {
      client.matchId = match.id;
      client.isSpectator = true;
    }
    send(ws, { type: 'match_state', match: { ...match }, view: viewOf(match) });
    return;
  }

  send(ws, { type: 'error', message: 'Lobby or match not found' });
}

function handleReconnect(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client) {
    send(ws, { type: 'error', message: 'Session not found' });
    return;
  }

  // Lobby reconnection (page reload during lobby phase)
  if (msg.lobbyId) {
    // Cancel any pending disconnect for this player (page reload recovery)
    const discoKey = msg.playerId ? `lobby:${msg.lobbyId}:${msg.playerId}` : `lobby:${msg.lobbyId}:`;
    cancelDisconnect(discoKey);

    const lobby = getLobby(msg.lobbyId);
    if (!lobby) {
      send(ws, { type: 'error', message: 'Lobby not found' });
      return;
    }

    // Local lobby with no players: just re-associate client with lobby
    if (!msg.playerId) {
      client.lobbyId = lobby.id;
      if (lobby.isLocal) {
        lobby.hostSessionId = client.sessionId;
      }
      send(ws, { type: 'lobby_state', lobby: { ...lobby } });
      return;
    }

    const player = lobby.players.find((p) => p.id === msg.playerId);
    if (!player) {
      send(ws, { type: 'error', message: 'Player not found in lobby' });
      return;
    }

    // Update session references on reconnect (page reload gives new WebSocket session)
    player.sessionId = client.sessionId;
    if (player.id === lobby.hostPlayerId || lobby.isLocal) {
      lobby.hostSessionId = client.sessionId;
    }

    client.lobbyId = lobby.id;
    client.playerId = msg.playerId;
    send(ws, { type: 'lobby_state', lobby: { ...lobby }, yourPlayerId: lobby.isLocal ? undefined : msg.playerId });
    return;
  }

  // Match reconnection (page reload during match)
  if (msg.matchId) {
    // Cancel any pending disconnect for this player (page reload recovery)
    cancelDisconnect(`match:${msg.matchId}:${msg.playerId}`);

    const match = getMatch(msg.matchId);
    if (!match) {
      send(ws, { type: 'error', message: 'Match not found' });
      return;
    }
    const player = match.players.find((p) => p.id === msg.playerId);
    if (!player) {
      send(ws, { type: 'error', message: 'Player not found in match' });
      return;
    }
    // Leaving is final: a player who walked out does not come back, however they walked out.
    if (match.departed.includes(msg.playerId)) {
      send(ws, { type: 'error', message: 'You have left this match' });
      return;
    }
    // Update session reference on reconnect (page reload gives new WebSocket session)
    player.sessionId = client.sessionId;
    client.matchId = match.id;
    client.playerId = msg.playerId;
    send(ws, { type: 'match_state', match: { ...match }, view: viewOf(match) });
    return;
  }

  send(ws, { type: 'error', message: 'No lobby or match ID provided for reconnect' });
}

// ============================================================
// Scoring devices
// ============================================================

/** Live scoring-device sockets, by device id. The registry in devices.ts holds no sockets. */
const deviceSockets = new Map<string, WebSocket>();

function findSessionSocket(sessionId: string): WebSocket | null {
  for (const [ws, client] of clients) {
    if (!client.deviceId && client.sessionId === sessionId) return ws;
  }
  return null;
}

/** Tell a frontend how its devices are doing. */
function publishDevicesState(sessionId: string): void {
  const ws = findSessionSocket(sessionId);
  if (!ws) return;
  send(ws, { type: 'devices_state', devices: devicesForSession(sessionId) });
}

/** Tell a scoring device where it stands. A retained topic: pushed on connect and on every change. */
function publishScorerState(deviceId: string): void {
  const ws = deviceSockets.get(deviceId);
  if (!ws) return;
  const owner = ownerOf(deviceId);
  send(ws, {
    type: 'scorer_state',
    status: owner ? 'active' : 'waiting',
    cameras: owner ? activeCameras(owner).length : 0,
  });
}

/** The devices this frontend has active with a running camera. */
function activeCameras(ownerSessionId: string): string[] {
  return devicesForSession(ownerSessionId)
    .filter((d) => d.online && d.cameraActive)
    .map((d) => d.deviceId);
}

/**
 * Which match a frontend's cameras score into, and for whom.
 *
 * The owner must be an actual player in a running match. Spectators get a `matchId` too, which is
 * exactly why the check is here: a spectator with a paired camera must not become a scorer.
 */
function resolveScoringTarget(ownerSessionId: string): { match: MatchState; ownerPlayerId: string | null } | null {
  for (const client of clients.values()) {
    if (client.deviceId || client.sessionId !== ownerSessionId) continue;
    if (client.isSpectator || !client.matchId) return null;
    const match = getMatch(client.matchId);
    if (!match || match.status !== 'in_progress') return null;
    // A local match is one board scored for whoever is up; an online one scores only for its owner.
    return { match, ownerPlayerId: match.isLocal ? null : client.playerId };
  }
  return null;
}

/**
 * One inference's dart tips from a scoring device.
 *
 * Everything here is a reason to drop the report silently rather than to answer: a scoring device
 * that has lost its right to speak should learn that from `scorer_state`, not from an error frame
 * arriving once per frame.
 */
function handleScorerTips(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.deviceId) return;

  // A malformed report is dropped whole. It is never salvaged into an empty array, because an
  // empty array means the darts came out.
  const tips = validateTips(msg.tips);
  if (!tips) return;

  const owner = ownerOf(client.deviceId);
  if (!owner) return;
  const target = resolveScoringTarget(owner);
  if (!target) return;

  const session = getScoringSession(target.match.id, target.ownerPlayerId, commitScoredMatch);
  session.setCameras(activeCameras(owner));
  session.addTips(client.deviceId, tips);
}

/**
 * The match changed: persist it, tell everyone in it, and refresh the scoring devices watching it.
 * Used by manual darts and camera darts alike — there is only one way a match moves.
 */
function commitScoredMatch(match: MatchState): void {
  updateMatch(match.id, match);
  broadcastToMatch(match.id, { type: 'match_state', match: { ...match }, view: viewOf(match) });
  if (match.status !== 'in_progress') dropScoringSessions(match.id);
  for (const deviceId of scoringDevicesFor(match.id)) publishScorerState(deviceId);
}

/** Every scoring device whose owner is playing in this match. */
function scoringDevicesFor(matchId: string): string[] {
  const found: string[] = [];
  for (const client of clients.values()) {
    if (client.deviceId || client.matchId !== matchId || client.isSpectator) continue;
    for (const device of devicesForSession(client.sessionId)) {
      if (device.online) found.push(device.deviceId);
    }
  }
  return found;
}

function handleCreatePairingCode(ws: WebSocket): void {
  const client = clients.get(ws);
  if (!client) return;
  const { code, expiresAt } = createPairingCode(client.sessionId);
  send(ws, { type: 'pairing_code', code, expiresAt });
}

/**
 * A frontend taking devices for this session — sent on every connect for whatever this tab has
 * active, which is what re-establishes a pairing after a server restart.
 */
function handleActivateDevices(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client) return;

  for (const claim of validateDeviceClaims(msg.devices)) {
    const previousOwner = ownerOf(claim.deviceId);
    const result = claimDevice(claim.deviceId, claim.tokenHash, client.sessionId, claim.grabbedAt);
    if (result === 'stale') {
      // Another tab of this browser holds it with a newer grab. Say so, so this one stops asking.
      send(ws, { type: 'device_lost', deviceId: claim.deviceId });
      continue;
    }
    if (result === 'mismatch') continue;
    if (previousOwner && previousOwner !== client.sessionId) {
      const loser = findSessionSocket(previousOwner);
      if (loser) send(loser, { type: 'device_lost', deviceId: claim.deviceId });
      publishDevicesState(previousOwner);
    }
    publishScorerState(claim.deviceId);
  }

  publishDevicesState(client.sessionId);
}

function handleDeactivateDevice(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client || typeof msg.deviceId !== 'string') return;
  if (!unclaimDevice(msg.deviceId, client.sessionId)) return;
  publishScorerState(msg.deviceId);
  publishDevicesState(client.sessionId);
}

function handleScorerPair(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client || client.deviceId) return;

  const paired = redeemPairingCode(msg.code, client.sessionId);
  if (!paired) {
    send(ws, { type: 'scorer_refused', reason: 'bad_code' });
    return;
  }

  bindDeviceSocket(ws, client, paired.deviceId);
  send(ws, { type: 'scorer_paired', deviceId: paired.deviceId, token: paired.token });

  // The frontend that showed the code has to persist the hash: the server will not remember it,
  // and it is what proves the pairing again after a restart.
  const owner = findSessionSocket(paired.ownerSessionId);
  if (owner) send(owner, { type: 'device_paired', deviceId: paired.deviceId, tokenHash: paired.tokenHash });
}

function handleScorerHello(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client || client.deviceId) return;

  const device = verifyDevice(msg.deviceId, msg.token, sanitizeName(msg.name) ?? '');
  if (!device) {
    send(ws, { type: 'scorer_refused', reason: 'unpaired' });
    return;
  }

  bindDeviceSocket(ws, client, device.id);
  const owner = ownerOf(device.id);
  if (owner) publishDevicesState(owner);
}

/** A device renaming itself. It owns its own name; a frontend only displays what it is told. */
function handleScorerName(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.deviceId) return;

  setDeviceName(client.deviceId, sanitizeName(msg.name) ?? '');
  const owner = ownerOf(client.deviceId);
  if (owner) publishDevicesState(owner);
}

function handleScorerCamera(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.deviceId) return;

  setCameraActive(client.deviceId, Boolean(msg.active));
  const owner = ownerOf(client.deviceId);
  if (owner) {
    // A camera leaving must leave the roster at once, or every throw window afterwards waits for a
    // report that is never coming.
    const target = resolveScoringTarget(owner);
    if (target) {
      getScoringSession(target.match.id, target.ownerPlayerId, commitScoredMatch).setCameras(activeCameras(owner));
    }
    publishDevicesState(owner);
  }
  publishScorerState(client.deviceId);
}

/** One socket per device: a second connection for the same id displaces the first. */
function bindDeviceSocket(ws: WebSocket, client: Client, deviceId: string): void {
  const existing = deviceSockets.get(deviceId);
  if (existing && existing !== ws) {
    const stale = clients.get(existing);
    if (stale) stale.deviceId = null;
    send(existing, { type: 'scorer_refused', reason: 'unpaired' });
  }
  client.deviceId = deviceId;
  deviceSockets.set(deviceId, ws);
  publishScorerState(deviceId);
}

/**
 * A player accepting or withdrawing a re-match. Everyone accepting starts one immediately.
 *
 * The vote lives on the match, so both sides watch each other's toggle through the ordinary state
 * broadcast rather than through a mechanism of its own.
 */
function handleRematchVote(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.matchId || client.isSpectator) return;

  const match = getMatch(client.matchId);
  if (!match || match.status !== 'finished') return;
  // Nobody is left to agree with.
  if (match.departed.length > 0) return;

  const player = match.players.find((p) => p.id === msg.playerId);
  if (!player) return;
  // You may answer for your own players — which in a local match is all of them.
  if (!match.isLocal && player.sessionId !== client.sessionId) {
    send(ws, { type: 'error', message: 'You can only answer for your own player' });
    return;
  }

  const voted = match.rematchVotes.includes(player.id);
  if (msg.accepted && !voted) match.rematchVotes.push(player.id);
  if (!msg.accepted && voted) match.rematchVotes = match.rematchVotes.filter((id) => id !== player.id);

  if (match.rematchVotes.length < match.players.length) {
    broadcastToMatch(match.id, { type: 'match_state', match: { ...match }, view: viewOf(match) });
    return;
  }

  if (!canCreateMatch()) {
    send(ws, { type: 'error', message: 'Server is full, try again later' });
    return;
  }

  // Everyone is in. The re-match is an ordinary new match; the only thing carried across is which
  // clients are watching it.
  const rematch = createRematch(match);
  for (const other of clients.values()) {
    if (other.matchId !== match.id || other.isSpectator) continue;
    other.matchId = rematch.id;
  }
  broadcastToMatch(rematch.id, { type: 'match_started', match: { ...rematch }, view: viewOf(rematch) });
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

  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
}
