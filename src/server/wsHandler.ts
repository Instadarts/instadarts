import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { Client } from './types';
import { parseMessage, formatMessage } from '../shared/protocol';
import { createLobby, getLobby, addPlayerToLobby, removePlayerFromLobby, createGame, getGame, findLobbyByInviteCode, updateGame } from './store';
import { generatePlayerId } from './player';
import { processVisit } from './game';
import { generateInviteCode } from './invite';

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

function handleCreateLobby(ws: WebSocket, _msg: any): void {
  const lobby = createLobby();
  const client = clients.get(ws);
  if (client) {
    client.lobbyId = lobby.id;
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
  }

  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
}

function handleAddLocalPlayer(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.lobbyId) return;

  const lobby = getLobby(client.lobbyId);
  if (!lobby) {
    send(ws, { type: 'error', message: 'Lobby not found' });
    return;
  }

  const player = {
    id: generatePlayerId(),
    name: msg.playerName || 'Player 2',
    isRemote: false,
  };

  const updated = addPlayerToLobby(lobby.id, player);
  if (!updated) {
    send(ws, { type: 'error', message: 'Lobby is full' });
    return;
  }

  broadcastToLobby(lobby.id, { type: 'player_joined', lobbyId: lobby.id, player });
  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
}

function handleRemovePlayer(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.lobbyId) return;

  const lobby = getLobby(client.lobbyId);
  if (!lobby) return;

  const player = lobby.players.find((p) => p.id === msg.playerId);
  if (!player) return;

  // Don't allow removing remote players from a local client
  if (player.isRemote) return;

  removePlayerFromLobby(lobby.id, msg.playerId);
  broadcastToLobby(lobby.id, { type: 'player_left', lobbyId: lobby.id, playerId: msg.playerId });
  broadcastToLobby(lobby.id, { type: 'lobby_state', lobby: { ...lobby } });
}

function handleUpdateSettings(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (!client?.lobbyId) return;

  const lobby = getLobby(client.lobbyId);
  if (!lobby) return;

  lobby.settings = { ...lobby.settings, ...msg.settings };
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

  const lobby = getLobby(client.lobbyId);
  if (!lobby) {
    send(ws, { type: 'error', message: 'Lobby not found' });
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

  const result = processVisit(game, {
    ...msg.visit,
    visitNumber: 0,
  });

  if (!result.success) {
    send(ws, { type: 'error', message: result.error });
    return;
  }

  updateGame(game.id, result.game);
  broadcastToGame(game.id, { type: 'game_state', game: { ...result.game } });
}

function handleLeaveGame(ws: WebSocket, msg: any): void {
  const client = clients.get(ws);
  if (client) {
    client.gameId = null;
    client.lobbyId = null;
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
