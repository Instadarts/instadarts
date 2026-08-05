import type { GameState, Lobby, Player } from '../shared/types';

// ============================================================
// In-memory stores
// ============================================================

const lobbies = new Map<string, Lobby>();
const games = new Map<string, GameState>();

// ============================================================
// ID generation
// ============================================================

let nextId = 1;
function generateId(): string {
  return (nextId++).toString(36);
}

// ============================================================
// Lobby operations
// ============================================================

export function createLobby(): Lobby {
  const id = generateId();
  const lobby: Lobby = {
    id,
    players: [],
    settings: {
      mode: 'x01',
      doubleIn: false,
      doubleOut: true,
      startScore: 501,
    },
    inviteCode: null,
    hostPlayerId: null,
    isLocal: true,
  };
  lobbies.set(id, lobby);
  return lobby;
}

export function getLobby(id: string): Lobby | undefined {
  return lobbies.get(id);
}

export function deleteLobby(id: string): void {
  lobbies.delete(id);
}

export function addPlayerToLobby(lobbyId: string, player: Player): Lobby | null {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;
  if (lobby.players.length >= 2) return null;
  lobby.players.push(player);
  return lobby;
}

export function removePlayerFromLobby(lobbyId: string, playerId: string): Lobby | null {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;
  lobby.players = lobby.players.filter((p) => p.id !== playerId);
  return lobby;
}

export function setLobbyInviteCode(lobbyId: string, code: string): boolean {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return false;
  lobby.inviteCode = code;
  return true;
}

export function findLobbyByInviteCode(code: string): Lobby | undefined {
  for (const lobby of lobbies.values()) {
    if (lobby.inviteCode === code) return lobby;
  }
  return undefined;
}

// ============================================================
// Game operations
// ============================================================

export function createGame(lobby: Lobby): GameState {
  deleteLobby(lobby.id);
  const id = generateId();
  const game: GameState = {
    id,
    status: 'in_progress',
    settings: { ...lobby.settings },
    players: lobby.players.map((p) => ({ ...p })),
    visits: [],
    currentPlayerIndex: 0,
    winnerId: null,
  };
  games.set(id, game);
  return game;
}

export function getGame(id: string): GameState | undefined {
  return games.get(id);
}

export function updateGame(id: string, game: GameState): boolean {
  if (!games.has(id)) return false;
  games.set(id, game);
  return true;
}

export function deleteGame(id: string): void {
  games.delete(id);
}

// ============================================================
// GC helpers
// ============================================================

export function getAllGames(): Map<string, GameState> {
  return games;
}

export function getAllLobbies(): Map<string, Lobby> {
  return lobbies;
}
