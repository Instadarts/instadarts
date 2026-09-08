// Integration ownership and retained results. No credentials are placed on public room objects.
import { randomUUID } from 'node:crypto';
import type { Lobby, MatchSettings, MatchState, ModeView, Player } from '../shared/types';
import { DEFAULT_FORMAT, MATCH_FIELDS, standingsOf, type Standings } from '../shared/matchFormat';
import { CONFIG } from './config';
import { canAddRoom } from './capacity';
import { createLobby, getLobby, getMatch, maxPlayersFor } from './store';
import { joinedPlayerIds, publicPlayers } from './connections';
import { generatePersonalInvite } from './invite';
import { getMode } from './modes/types';
import { viewOf } from './match';
import { sanitizeName, validateField } from './validation';

export const API_RETENTION_MS = 24 * 60 * 60_000;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface ApiMatchResult {
  matchId: string;
  lobbyId: string;
  status: 'waiting' | 'in_progress' | 'finished' | 'cancelled' | 'expired';
  settings: MatchSettings;
  players: Player[];
  joinedPlayerIds: string[];
  standings: Standings;
  playerScores: ModeView['playerScores'];
  winnerId: string | null;
  departed: string[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  roomExpiresAt: number;
  resultExpiresAt: number | null;
  history?: Pick<MatchState, 'legs' | 'visits' | 'currentVisit'>;
}

interface ApiRecord {
  callerId: string;
  matchId: string;
  lobbyId: string;
  createdAt: number;
  result?: ApiMatchResult;
}
const records = new Map<string, ApiRecord>();
const lobbyMatches = new Map<string, string>();

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function invalid(message: string): never { throw new ApiError(400, 'invalid_request', message); }
function knownKeys(raw: Record<string, unknown>, keys: string[], path: string): void {
  if (Object.keys(raw).some((key) => !keys.includes(key))) invalid(`Unknown field in ${path}`);
}

function settingsFrom(raw: unknown): MatchSettings {
  const input = object(raw, 'settings');
  knownKeys(input, ['mode', 'modeSettings', ...MATCH_FIELDS.map((f) => f.key)], 'settings');
  const mode = typeof input.mode === 'string' ? getMode(input.mode) : undefined;
  if (!mode) invalid('settings.mode must name a registered game mode');
  const modeInput = input.modeSettings === undefined ? {} : object(input.modeSettings, 'settings.modeSettings');
  knownKeys(modeInput, mode.fields.map((f) => f.key), 'settings.modeSettings');
  const modeSettings = { ...mode.defaults };
  const format = { ...DEFAULT_FORMAT };
  for (const field of mode.fields) {
    if (!Object.hasOwn(modeInput, field.key)) continue;
    const value = validateField(field, modeInput[field.key]);
    if (value === undefined) invalid(`Invalid settings.modeSettings.${field.key}`);
    modeSettings[field.key] = value;
  }
  for (const field of MATCH_FIELDS) {
    if (!Object.hasOwn(input, field.key)) continue;
    const value = validateField(field, input[field.key]);
    if (typeof value !== 'number') invalid(`Invalid settings.${field.key}`);
    format[field.key as keyof typeof format] = value;
  }
  return { mode: mode.id, modeSettings, ...format };
}

export function createApiMatch(callerId: string, raw: unknown) {
  const input = object(raw, 'request');
  knownKeys(input, ['settings', 'players'], 'request');
  const settings = settingsFrom(input.settings);
  if (!Array.isArray(input.players) || input.players.length < 1 || input.players.length > maxPlayersFor(settings.mode)) {
    invalid(`players must contain 1-${maxPlayersFor(settings.mode)} entries`);
  }
  const names = input.players.map((entry) => {
    const player = object(entry, 'player');
    knownKeys(player, ['name'], 'player');
    const name = sanitizeName(player.name);
    if (!name) invalid('Player names must contain 1-20 characters');
    return name;
  });
  sweepApiRecords();
  if (!canAddRoom() || records.size >= CONFIG.server.maxMatches) {
    throw new ApiError(503, 'capacity_exceeded', 'Server room or API retention capacity is full');
  }
  const lobby = createLobby();
  lobby.apiManaged = true;
  lobby.acceptsJoins = true;
  lobby.settings = settings;
  lobby.players = names.map((name) => ({ id: randomUUID(), name }));
  const matchId = randomUUID();
  records.set(matchId, { callerId, matchId, lobbyId: lobby.id, createdAt: lobby.createdAt });
  lobbyMatches.set(lobby.id, matchId);
  return {
    lobbyId: lobby.id, matchId, settings,
    players: lobby.players.map((p) => ({ ...p, inviteCode: generatePersonalInvite(lobby.id, p.id) })),
  };
}

export function reservedMatchId(lobbyId: string): string | undefined { return lobbyMatches.get(lobbyId); }
export function apiWaitingLobby(matchId: string): Lobby | undefined {
  const record = records.get(matchId);
  return record && !record.result ? getLobby(record.lobbyId) : undefined;
}

function snapshot(record: ApiRecord, room: Lobby | MatchState): ApiMatchResult {
  const match = 'status' in room ? room : undefined;
  const finished = match?.status === 'finished';
  return {
    matchId: record.matchId, lobbyId: record.lobbyId,
    status: match ? (finished ? (match.winnerId ? 'finished' : 'cancelled') : 'in_progress') : 'waiting',
    settings: room.settings, players: publicPlayers(room.players),
    joinedPlayerIds: match ? [] : joinedPlayerIds(room as Lobby),
    standings: standingsOf(match?.legs ?? [], room.settings),
    playerScores: match ? viewOf(match).playerScores : {},
    winnerId: match?.winnerId ?? null, departed: match?.departed ?? [],
    createdAt: record.createdAt, startedAt: match?.createdAt ?? null,
    finishedAt: match?.finishedAt ?? null, roomExpiresAt: room.expiresAt,
    resultExpiresAt: finished ? match!.finishedAt! + API_RETENTION_MS : null,
    history: { legs: match?.legs ?? [], visits: match?.visits ?? [], ...(match?.currentVisit ? { currentVisit: match.currentVisit } : {}) },
  };
}

/** First terminal state wins. Subsequent summary departures cannot rewrite the result. */
export function archiveApiMatch(match: MatchState): void {
  const record = records.get(match.id);
  if (!record || record.result || match.status !== 'finished') return;
  record.result = structuredClone(snapshot(record, match));
}

export function archiveApiLobby(lobby: Lobby): void {
  const id = reservedMatchId(lobby.id);
  const record = id ? records.get(id) : undefined;
  if (!record || record.result) return;
  const result = snapshot(record, lobby);
  result.status = 'expired';
  result.finishedAt = Date.now();
  result.resultExpiresAt = result.finishedAt + API_RETENTION_MS;
  record.result = structuredClone(result);
}

export function getApiMatch(callerId: string, matchId: string, includeHistory = false): ApiMatchResult {
  sweepApiRecords();
  const record = records.get(matchId);
  if (!record || record.callerId !== callerId) throw new ApiError(404, 'not_found', 'Match not found');
  const room = getMatch(matchId) ?? getLobby(record.lobbyId);
  const result = record.result ?? (room ? snapshot(record, room) : undefined);
  if (!result) throw new ApiError(404, 'not_found', 'Match not found');
  if (includeHistory) return { ...result };
  const { history: _history, ...summary } = result;
  return summary;
}

export function sweepApiRecords(now = Date.now()): void {
  for (const [id, record] of records) {
    const expired = record.result?.resultExpiresAt != null && now >= record.result.resultExpiresAt;
    // Recover the record budget if a room disappeared outside the normal archival paths.
    // A room that still exists has no maximum age: participant input can keep it alive.
    const orphaned = !record.result && !getMatch(id) && !getLobby(record.lobbyId);
    if (expired || orphaned) {
      records.delete(id);
      lobbyMatches.delete(record.lobbyId);
    }
  }
}
