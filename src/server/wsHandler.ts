// The gameplay half of the socket layer: lobbies, matches, spectating, re-matches, and the routing
// that every message arrives through.
//
// Two things it deliberately does not hold. **Who is connected** is connections.ts — the registry
// and the ways of addressing it, which the scoring-device handlers need just as much as these do.
// **Scoring devices** are scoringDevices.ts, which shares nothing with this file but that registry
// and `commitScoredMatch` — the one function through which a match moves, whether its darts were
// clicked here or seen by a camera there.
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
import { checkRateLimit, checkTipsRateLimit, releaseRateLimit } from './rateLimit';
import { dropScoringSessions } from './scoring/store';
import { allModes, describeMode } from './modes/types';
import { canCreateLobby, canCreateMatch } from './capacity';
import { SUMMARY_TTL_MS, setLifecycleHandlers, touch } from './lifecycle';
import {
  addClient,
  allClients,
  broadcastToLobby,
  broadcastToMatch,
  dropClient,
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
  dropClient(ws);
}

// ============================================================
// Request guards
// ============================================================

/** Validates that the client is playing in an active match. Returns client+match or null (error already sent). */
function requireMatch(ws: WebSocket): { client: Client; match: MatchState } | null {
  const client = getClient(ws);
  if (!client?.matchId) return null;
  if (client.isSpectator) return null;
  const match = getMatch(client.matchId);
  if (!match) { send(ws, { type: 'error', message: 'Match not found' }); return null; }
  return { client, match };
}

/** Validates that the client is in a lobby. Returns client+lobby or null. Does NOT send errors for silent-return handlers. */
function requireLobby(ws: WebSocket): { client: Client; lobby: Lobby } | null {
  const client = getClient(ws);
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
  } else if (!checkRateLimit(client?.sessionId ?? `anon_${Math.random()}`)) {
    send(ws, { type: 'error', message: 'Rate limit exceeded' });
    return;
  }

  // A connection is a frontend or a scoring device, never both. Keeping the two vocabularies apart
  // means a compromised scoring device cannot reach a single gameplay handler.
  const isScorerMessage = msg.type.startsWith('scorer_');
  if (client?.deviceId && !isScorerMessage) return;
  if (isScorerMessage && !client?.deviceId && msg.type !== 'scorer_pair' && msg.type !== 'scorer_hello') return;

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
      break;
    case 'scorer_hello':
      handleScorerHello(ws, msg);
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
  },
});

/** Message types that count as input for the idle timeout. */
const INPUT_TYPES = new Set([
  'create_lobby', 'join_lobby', 'add_local_player', 'remove_player', 'set_player_name',
  'update_settings', 'swap_players', 'start_match',
  'add_dart', 'undo_dart', 'submit_visit', 'rematch_vote',
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
  }

  generateInviteCode(lobby.id);
  send(ws, lobbyMessage(lobby));
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
  }

  // Send direct response to joining client (in case not yet in clients map)
  send(ws, lobbyMessage(lobby));
  broadcastToLobby(lobby.id, lobbyMessage(lobby), ws);
}

function handleAddLocalPlayer(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
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

  // Everyone sees the lobby; only this connection is told which player is its own — and in a local
  // match, where one user holds them all, that question has no answer.
  broadcastToLobby(lobby.id, lobbyMessage(lobby));
  send(ws, lobbyMessage(lobby, lobby.isLocal ? undefined : player.id));
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
  const client = getClient(ws);
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
  for (const [w, c] of allClients()) {
    if (c.lobbyId === lobby.id) {
      c.matchId = match.id;
      c.lobbyId = null;
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
 * Leaving is final. The player is recorded as departed, which bars them from reconnecting, and it
 * stands as their answer to a re-match: **walking out is a decline.** That is what makes the answer
 * always converge — there is no way to leave the question open by disappearing.
 */
function leaveMatch(_ws: WebSocket, client: Client): void {
  // Captured up front: below, this client's own `matchId` is cleared, and its devices are found
  // through it.
  const devices = devicesScoringInto(client.matchId!);
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
}

function leaveLobby(ws: WebSocket, client: Client): void {
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
    send(ws, lobbyMessage(lobby));
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

function handleReconnect(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
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
      send(ws, lobbyMessage(lobby));
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
    send(ws, lobbyMessage(lobby, lobby.isLocal ? undefined : msg.playerId));
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
    if (match.isLocal) cancelDisconnectsForMatch(match.id);
    // Leaving is final: a player who walked out does not come back, however they walked out.
    if (match.departed.includes(msg.playerId)) {
      send(ws, { type: 'error', message: 'You have left this match' });
      return;
    }
    // Update session reference on reconnect (page reload gives new WebSocket session)
    player.sessionId = client.sessionId;
    client.matchId = match.id;
    client.playerId = msg.playerId;
    send(ws, matchMessage('match_state', match));
    return;
  }

  send(ws, { type: 'error', message: 'No lobby or match ID provided for reconnect' });
}

/**
 * A player accepting or withdrawing a re-match. Everyone accepting starts one immediately.
 *
 * The vote lives on the match, so both sides watch each other's toggle through the ordinary state
 * broadcast rather than through a mechanism of its own.
 */
function handleRematchVote(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
  if (!client?.matchId || client.isSpectator) return;

  const match = getMatch(client.matchId);
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
  for (const [, other] of allClients()) {
    if (other.matchId !== match.id) continue;
    other.matchId = rematch.id;
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
