import type { MatchState, MatchSettings, Lobby, Player } from '../shared/types';
import { DEFAULT_MODE, getMode } from './modes/types';
import { DEFAULT_FORMAT } from '../shared/matchFormat';
import { IDLE_TTL_MS } from './lifecycle';
import { carrySeats, dropSeats } from './seats';
import { CONFIG } from './config';
import { effectiveMaxPlayers } from '../shared/settings';

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
    settings: { mode: DEFAULT_MODE, modeSettings: { ...getMode(DEFAULT_MODE)!.defaults }, ...DEFAULT_FORMAT },
    inviteCode: null,
    hostPlayerId: null,
    hostSessionId: null,
    isLocal: true,
    maxPlayers: effectiveMaxPlayers(CONFIG.server.maxPlayersPerMatch, getMode(DEFAULT_MODE)?.maxPlayers),
    userCount: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + IDLE_TTL_MS,
  };
  lobbies.set(id, lobby);
  return lobby;
}

export function getLobby(id: string): Lobby | undefined {
  return lobbies.get(id);
}

export function deleteLobby(id: string): void {
  lobbies.delete(id);
  dropSeats(id);
}

export function addPlayerToLobby(lobbyId: string, player: Player): Lobby | null {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;
  const max = effectiveMaxPlayers(CONFIG.server.maxPlayersPerMatch, getMode(lobby.settings.mode)?.maxPlayers);
  if (lobby.players.length >= max) return null;
  lobby.players.push(player);
  return lobby;
}

export function removePlayerFromLobby(lobbyId: string, playerId: string): Lobby | null {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;
  lobby.players = lobby.players.filter((p) => p.id !== playerId);
  return lobby;
}

export function movePlayerInLobby(lobbyId: string, playerId: string, direction: 'up' | 'down'): Lobby | null {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;
  const index = lobby.players.findIndex((p) => p.id === playerId);
  if (index < 0) return null;
  if (direction === 'up') {
    if (index === 0) return null;
    [lobby.players[index], lobby.players[index - 1]] = [lobby.players[index - 1], lobby.players[index]];
    return lobby;
  }
  if (direction === 'down') {
    if (index === lobby.players.length - 1) return null;
    [lobby.players[index], lobby.players[index + 1]] = [lobby.players[index + 1], lobby.players[index]];
    return lobby;
  }
  return null;
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

/**
 * A match at its beginning. The only way one is ever created, so a match started from a lobby and a
 * re-match are the same thing to everything downstream.
 */
function startMatch(settings: MatchSettings, players: Player[], isLocal: boolean): MatchState {
  const id = generateId();
  const match: MatchState = {
    id,
    status: 'in_progress',
    settings: { ...settings, modeSettings: { ...settings.modeSettings } },
    players: players.map((p) => ({ ...p })),
    visits: [],
    legs: [],
    currentPlayerIndex: 0,
    winnerId: null,
    createdAt: Date.now(),
    finishedAt: null,
    isLocal,
    departed: [],
    rematchVotes: {},
    expiresAt: Date.now() + IDLE_TTL_MS,
  };
  matches.set(id, match);
  return match;
}

export function createMatch(lobby: Lobby): MatchState {
  const match = startMatch(lobby.settings, lobby.players, lobby.isLocal);
  // Before the lobby goes: everyone who held a place in it holds the same place in the match, and
  // their tab has no way of hearing that the room it can name has changed id.
  carrySeats(lobby.id, match.id);
  deleteLobby(lobby.id);
  return match;
}

/**
 * A re-match: the same rules and the same participants, with the order rotated by one so the next
 * player begins. With two players that is the order reversed, which is all it ever used to be.
 *
 * Nothing else carries over — it is an ordinary new match that happens to skip the lobby, not a
 * continuation. Nothing anywhere needs to know it came from another match, which is why this
 * function does not record that it did.
 */
export function createRematch(previous: MatchState): MatchState {
  const players = previous.players.length > 1
    ? [...previous.players.slice(1), previous.players[0]]
    : [...previous.players];
  const match = startMatch(previous.settings, players, previous.isLocal);
  carrySeats(previous.id, match.id);
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
  dropSeats(id);
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
