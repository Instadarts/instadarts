import type { MatchState, MatchSettings, Lobby, Player } from '../shared/types';
import { DEFAULT_MODE, getMode } from './modes/types';
import { DEFAULT_FORMAT } from '../shared/matchFormat';
import { IDLE_TTL_MS } from './lifecycle';

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
    remoteConnected: false,
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
  deleteLobby(lobby.id);
  return startMatch(lobby.settings, lobby.players, lobby.isLocal);
}

/**
 * A re-match: the same rules and the same participants, with the order switched so the other player
 * begins.
 *
 * Nothing else carries over — it is an ordinary new match that happens to skip the lobby, not a
 * continuation. Nothing anywhere needs to know it came from another match, which is why this
 * function does not record that it did.
 */
export function createRematch(previous: MatchState): MatchState {
  return startMatch(previous.settings, [...previous.players].reverse(), previous.isLocal);
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
