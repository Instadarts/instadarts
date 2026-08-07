import type { MatchState, Lobby, Player } from '../shared/types';
import { DEFAULT_MODE, defaultSettingsFor } from '../shared/modes/catalog';

// ============================================================
// In-memory stores
// ============================================================

const lobbies = new Map<string, Lobby>();
const matches = new Map<string, MatchState>();

// ============================================================
// ID generation
// ============================================================

function generateId(): string {
  return crypto.randomUUID();
}

// ============================================================
// Lobby operations
// ============================================================

export function createLobby(): Lobby {
  const id = generateId();
  const lobby: Lobby = {
    id,
    players: [],
    settings: { mode: DEFAULT_MODE, modeSettings: defaultSettingsFor(DEFAULT_MODE)! },
    inviteCode: null,
    hostPlayerId: null,
    hostSessionId: null,
    isLocal: true,
    remoteConnected: false,
    createdAt: Date.now(),
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

export function swapLobbyPlayers(lobbyId: string): Lobby | null {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || lobby.players.length < 2) return null;
  [lobby.players[0], lobby.players[1]] = [lobby.players[1], lobby.players[0]];
  return lobby;
}

export function setLobbyInviteCode(lobbyId: string, code: string): Lobby | null {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;
  lobby.inviteCode = code;
  return lobby;
}

export function findLobbyByInviteCode(code: string): Lobby | undefined {
  for (const lobby of lobbies.values()) {
    if (lobby.inviteCode === code) return lobby;
  }
  return undefined;
}

// ============================================================
// Match operations
// ============================================================

export function createMatch(lobby: Lobby): MatchState {
  deleteLobby(lobby.id);
  const id = generateId();
  const match: MatchState = {
    id,
    status: 'in_progress',
    settings: { ...lobby.settings },
    players: lobby.players.map((p) => ({ ...p })),
    visits: [],
    currentPlayerIndex: 0,
    winnerId: null,
    createdAt: Date.now(),
    finishedAt: null,
    isLocal: lobby.isLocal,
  };
  matches.set(id, match);
  return match;
}

export function getMatch(id: string): MatchState | undefined {
  return matches.get(id);
}

export function updateMatch(id: string, match: MatchState): boolean {
  if (!matches.has(id)) return false;
  matches.set(id, match);
  return true;
}

export function deleteMatch(id: string): void {
  matches.delete(id);
}

// ============================================================
// GC helpers
// ============================================================

export function getAllMatches(): ReadonlyMap<string, MatchState> {
  return matches;
}

export function getAllLobbies(): ReadonlyMap<string, Lobby> {
  return lobbies;
}
