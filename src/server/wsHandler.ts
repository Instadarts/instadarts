import type { WebSocket } from 'ws';
import type { ServerMessage } from '../shared/protocol';
import type { Client } from './types';
import { parseMessage, formatMessage } from '../shared/protocol';
import { createLobby, getLobby, addPlayerToLobby, removePlayerFromLobby, createGame, getGame, findLobbyByInviteCode, updateGame, deleteLobby, deleteGame } from './store';
import { generatePlayerId } from './player';
import { processVisit } from './game';
import { generateInviteCode } from './invite';
import { sanitizeName, validateSettings, validateVisit } from './validation';
import { checkRateLimit, removeRateLimitBucket } from './rateLimit';
import { canCreateLobby, canCreateGame } from './concurrencyLimit';

// ============================================================
// Client registry
// ============================================================

const clients = new Map<WebSocket, Client>();

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
  }
  clients.delete(ws);
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
    if (client.lobbyId === lobbyId || client.gameId === lobbyId) {
      send(ws, msg);
    }
  }
}

function broadcastToGame(gameId: string, msg: ServerMessage): void {
  for (const [ws, client] of clients) {
    if (client.gameId === gameId) {
      send(ws, msg);
    }
  }
}

// ============================================================
// Message routing
// ============================================================

export function handleMessage(ws: WebSocket, raw: string): void {
  // Rate limit
  const client = clients.get(ws);
  const connId = client?.playerId ?? `anon_${Math.random()}`;
  if (!checkRateLimit(connId)) {
    send(ws, { type: 'error', message: 'Rate limit exceeded' });
    return;
  }

  const msg = parseMessage(raw);
  if (!msg) {
    send(ws, { type: 'error', message: 'Invalid message format' });
    return;
  }

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
    case 'start_game':
      handleStartGame(ws, msg);
      break;
    case 'submit_visit':
      handleSubmitVisit(ws, msg);
      break;
    case 'leave_game':
      handleLeaveGame(ws, msg);
      break;
    case 'reconnect':
      handleReconnect(ws, msg);
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
  lobby.isLocal = msg.isLocal !== false; // default to local for safety
  const client = clients.get(ws);
  if (client) {
    client.lobbyId = lobby.id;
    client.isHost = true;
  }

  // Auto-generate invite code
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

  if (lobby.players.length >= 2) {
    send(ws, { type: 'error', message: 'Lobby is full' });
    return;
  }

  // Associate client with lobby — player is added manually via add_local_player
  const client = clients.get(ws);
  if (client) {
    client.lobbyId = lobby.id;
    client.isHost = false;
  }

  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
}

function handleAddLocalPlayer(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.lobbyId) return;

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

  const player = {
    id: generatePlayerId(),
    name,
    isRemote: false,
  };

  const updated = addPlayerToLobby(lobby.id, player);
  if (!updated) {
    send(ws, { type: 'error', message: 'Lobby is full' });
    return;
  }

  // Track which player this client owns
  client.playerId = player.id;

  // Broadcast to all; only send yourPlayerId to the requesting client for online lobbies
  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
  if (!lobby.isLocal) {
    send(ws, { type: 'lobby_state', lobby: { ...lobby }, yourPlayerId: player.id });
  } else {
    send(ws, { type: 'lobby_state', lobby: { ...lobby } });
  }
}

function handleRemovePlayer(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.lobbyId) return;

  const lobby = getLobby(client.lobbyId);
  if (!lobby) return;

  const player = lobby.players.find((p) => p.id === msg.playerId);
  if (!player) return;

  // Only allow removing your own player
  if (client.playerId !== msg.playerId) {
    send(ws, { type: 'error', message: 'You can only remove your own player' });
    return;
  }

  client.playerId = null;
  removePlayerFromLobby(lobby.id, msg.playerId);
  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
}

function handleUpdateSettings(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.lobbyId) return;

  // Only the host can update settings
  if (!client.isHost) {
    send(ws, { type: 'error', message: 'Only the match creator can change settings' });
    return;
  }

  const lobby = getLobby(client.lobbyId);
  if (!lobby) return;

  const validated = validateSettings(msg.settings);
  if (!validated) {
    send(ws, { type: 'error', message: 'Invalid settings' });
    return;
  }

  lobby.settings = { ...lobby.settings, ...validated };
  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
}

function handleSetPlayerName(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.lobbyId) return;

  const lobby = getLobby(client.lobbyId);
  if (!lobby) return;

  const player = lobby.players.find((p) => p.id === msg.playerId);
  if (player) {
    player.name = msg.name;
  }
  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
}

function handleStartGame(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.lobbyId) return;

  if (!client.isHost) {
    send(ws, { type: 'error', message: 'Only the match creator can start the game' });
    return;
  }

  if (!canCreateGame()) {
    send(ws, { type: 'error', message: 'Server is full, try again later' });
    return;
  }

  const lobby = getLobby(client.lobbyId);
  if (!lobby) {
    send(ws, { type: 'error', message: 'Lobby not found' });
    return;
  }

  if (lobby.players.length < 1) {
    send(ws, { type: 'error', message: 'Need at least one player to start' });
    return;
  }

  const game = createGame(lobby);

  // Update all lobby clients to game
  for (const [w, c] of clients) {
    if (c.lobbyId === lobby.id) {
      c.gameId = game.id;
      c.lobbyId = null;
    }
  }

  broadcastToGame(game.id, { type: 'game_started', game: { ...game } });
}

function handleSubmitVisit(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.gameId) return;

  const game = getGame(client.gameId);
  if (!game) {
    send(ws, { type: 'error', message: 'Game not found' });
    return;
  }

  // Validate visit structure and re-compute scores from coordinates
  const validatedVisit = validateVisit(msg.visit);
  if (!validatedVisit) {
    send(ws, { type: 'error', message: 'Invalid visit (1-3 darts with valid coordinates required)' });
    return;
  }

  const result = processVisit(game, {
    ...validatedVisit,
    visitNumber: 0,
  });

  if (!result.success) {
    send(ws, { type: 'error', message: result.error });
    return;
  }

  updateGame(game.id, result.game);
  broadcastToGame(game.id, { type: 'game_state', game: { ...result.game } });
}

function handleLeaveGame(ws: WebSocket, _msg: any): void {
  handleClientLeave(ws);
}

/**
 * Called when a client explicitly leaves or disconnects.
 */
export function handleClientLeave(ws: WebSocket): void {
  const client = clients.get(ws);
  if (!client) return;

  // Client is in a game → declare other player winner
  if (client.gameId) {
    const game = getGame(client.gameId);
    if (game && game.status === 'in_progress') {
      const otherPlayer = game.players.find((p) => p.id !== client.playerId);
      if (otherPlayer && game.players.length === 2) {
        game.status = 'finished';
        game.winnerId = otherPlayer.id;
        game.finishedAt = Date.now();
        broadcastToGame(game.id, { type: 'game_finished', game: { ...game } });
      }
    }
    client.gameId = null;
    client.playerId = null;
    return;
  }

  // Client is in a lobby
  if (client.lobbyId) {
    const lobby = getLobby(client.lobbyId);
    if (!lobby) {
      client.lobbyId = null;
      return;
    }

    if (client.isHost) {
      // Host left → abandon lobby, kick everyone
      broadcastToLobby(lobby.id, { type: 'lobby_abandoned' });
      // Disconnect all other lobby clients
      for (const [otherWs, otherClient] of clients) {
        if (otherWs !== ws && otherClient.lobbyId === lobby.id) {
          otherClient.lobbyId = null;
          otherClient.playerId = null;
          otherClient.isHost = false;
          // Also close their WebSocket to force cleanup
        }
      }
      deleteLobby(lobby.id);
    } else {
      // Non-host left → remove their player, refresh invite code
      if (client.playerId) {
        removePlayerFromLobby(lobby.id, client.playerId);
      }
      generateInviteCode(lobby.id);
      broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
    }

    client.lobbyId = null;
    client.playerId = null;
    client.isHost = false;
    return;
  }
}

function handleReconnect(ws: WebSocket, msg: any): void {
  const game = getGame(msg.gameId);
  if (!game) {
    send(ws, { type: 'error', message: 'Game not found' });
    return;
  }

  const client = clients.get(ws);
  if (client) {
    client.gameId = game.id;
    client.playerId = msg.playerId;
  }

  send(ws, { type: 'game_state', game: { ...game } });
}
