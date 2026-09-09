// Integration ownership and retained results. No credentials are placed on public room objects.
import { randomUUID } from 'node:crypto';
import type { Lobby, MatchSettings, MatchState, ModeView, Player } from '../shared/types';
import { DEFAULT_FORMAT, MATCH_FIELDS, standingsOf, type Standings } from '../shared/matchFormat';
import { canAddApiRecord, canAddRoom } from './capacity';
import type { LifecycleHandlers } from './lifecycle';
import { createLobby, getLobby, getMatch, maxPlayersFor } from './store';
import { joinedPlayerIds, publicPlayers } from './connections';
import { generatePersonalInvite } from './invite';
import { getMode } from './modes/types';
import { viewOf } from './match';
import { sanitizeName, validateField } from './validation';

/** How long a terminal result outlives its room. Listed with the room deadlines in lifecycle.ts. */
export const API_RETENTION_MS = 24 * 60 * 60_000;

export class ApiError extends Error {
  /** Methods this path does take, for the `Allow` header a 405 must carry. */
  constructor(public status: number, public code: string, message: string, public allow?: string[]) { super(message); }
}

/**
 * How a delete reaches the people in the room.
 *
 * The same object the lifecycle sweep is given, for the same reason its own comment gives: telling a
 * room anything belongs to the transport layer. Deleting a match is one of its deadlines arriving
 * early, so it runs the deadline's handler rather than a second implementation of it.
 */
let rooms: LifecycleHandlers | null = null;
export function setApiRoomHandlers(next: LifecycleHandlers): void { rooms = next; }

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
  const unknown = Object.keys(raw).find((key) => !keys.includes(key));
  if (unknown !== undefined) invalid(`Unknown field ${path}.${unknown}`);
}

function settingsFrom(raw: unknown): MatchSettings {
  const input = object(raw, 'settings');
  knownKeys(input, ['mode', 'modeSettings', ...MATCH_FIELDS.map((f) => f.key)], 'settings');
  const mode = typeof input.mode === 'string' ? getMode(input.mode) : undefined;
  if (!mode) invalid('settings.mode must name a registered game mode');
  const modeInput = input.modeSettings === undefined ? {} : object(input.modeSettings, 'settings.modeSettings');
  // A mode's own defaults name every setting it has; `fields` names only the editable ones. Anything
  // in the gap — Whac-A-Mole's seed, x01's production `stats` — is the server's to choose, so it is
  // recognised and skipped rather than refused. That is what lets a caller hand back the settings a
  // creation returned, which is otherwise a 400 that depends on whether the server is a dev build.
  // Capture generated defaults once, including the seed, and validate against that same bag.
  const modeSettings = { ...mode.defaults };
  knownKeys(modeInput, Object.keys(modeSettings), 'settings.modeSettings');
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
  if (!canAddRoom() || !canAddApiRecord(records.size)) {
    throw new ApiError(503, 'capacity_exceeded', 'Server room or API retention capacity is full');
  }
  const lobby = createLobby();
  lobby.apiManaged = true;
  lobby.settings = settings;
  // Not `generatePlayerId`, which is this server's own counter. These ids leave the building: they
  // are what an integration correlates its own records by, so they are opaque and scoped to the one
  // match rather than a number that says how many players this process has ever minted.
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

function statusOf(match?: MatchState): ApiMatchResult['status'] {
  if (!match) return 'waiting';
  if (match.status === 'finished') return match.winnerId ? 'finished' : 'cancelled';
  return 'in_progress';
}

function snapshot(record: ApiRecord, room: Lobby | MatchState, includeHistory: boolean): ApiMatchResult {
  const match = 'status' in room ? room : undefined;
  const finished = match?.status === 'finished';
  return {
    matchId: record.matchId, lobbyId: record.lobbyId,
    status: statusOf(match),
    settings: room.settings, players: publicPlayers(room.players),
    joinedPlayerIds: match ? [] : joinedPlayerIds(room as Lobby),
    standings: standingsOf(match?.legs ?? [], room.settings),
    playerScores: match ? viewOf(match).playerScores : {},
    winnerId: match?.winnerId ?? null, departed: match?.departed ?? [],
    createdAt: record.createdAt, startedAt: match?.createdAt ?? null,
    finishedAt: match?.finishedAt ?? null, roomExpiresAt: room.expiresAt,
    resultExpiresAt: finished ? match!.finishedAt! + API_RETENTION_MS : null,
    ...(includeHistory
      ? { history: { legs: match?.legs ?? [], visits: match?.visits ?? [], ...(match?.currentVisit ? { currentVisit: match.currentVisit } : {}) } }
      : {}),
  };
}

/** First terminal state wins. Subsequent summary departures cannot rewrite the result. */
export function archiveApiMatch(match: MatchState): void {
  const record = records.get(match.id);
  if (!record || record.result || match.status !== 'finished') return;
  record.result = structuredClone(snapshot(record, match, true));
}

export function archiveApiLobby(lobby: Lobby): void {
  const id = reservedMatchId(lobby.id);
  const record = id ? records.get(id) : undefined;
  if (!record || record.result) return;
  const result = snapshot(record, lobby, true);
  result.status = 'expired';
  result.finishedAt = Date.now();
  result.resultExpiresAt = result.finishedAt + API_RETENTION_MS;
  record.result = structuredClone(result);
}

/** The caller's own record, or the same 404 an unknown id gets: ownership is not discoverable. */
function ownedRecord(callerId: string, matchId: string): ApiRecord {
  const record = records.get(matchId);
  if (!record || record.callerId !== callerId) throw new ApiError(404, 'not_found', 'Match not found');
  return record;
}

export function getApiMatch(callerId: string, matchId: string, includeHistory = false): ApiMatchResult {
  sweepApiRecords();
  const record = ownedRecord(callerId, matchId);
  // An archived result answers on its own; only a live room has to be described.
  const room = record.result ? undefined : getMatch(matchId) ?? getLobby(record.lobbyId);
  const result = record.result ?? (room && snapshot(record, room, includeHistory));
  if (!result) throw new ApiError(404, 'not_found', 'Match not found');
  if (includeHistory) return { ...result };
  const { history: _history, ...summary } = result;
  return summary;
}

/**
 * The caller ending its own match, at whatever stage it has reached.
 *
 * The room is torn down through the deadline handler that would have ended it anyway — a waiting
 * lobby is abandoned, a running match is cancelled into its ordinary summary — and each of those
 * archives the result on its way past. So the payload is read back *after* the teardown rather than
 * composed here: there is one description of a finished API match, and this is not a second one.
 *
 * Then the record goes, before the response is delivered. Callers needing a recoverable copy must
 * retrieve and save it before deleting; the delete response itself can be lost. This frees the API
 * record immediately, but a match's summary keeps its room slot until its own deadline.
 */
export function deleteApiMatch(callerId: string, matchId: string): ApiMatchResult {
  sweepApiRecords();
  const record = ownedRecord(callerId, matchId);
  const live = !record.result;
  if (live) {
    const match = getMatch(matchId);
    const lobby = getLobby(record.lobbyId);
    if (match) rooms?.cancelIdleMatch(match);
    else if (lobby) rooms?.expireLobby(lobby);
  }
  const result = record.result;
  records.delete(matchId);
  lobbyMatches.delete(record.lobbyId);
  if (!result) throw new ApiError(404, 'not_found', 'Match not found');
  // A room that was still live did not reach a terminal state on its own — it was called off.
  return { ...result, ...(live ? { status: 'cancelled' as const } : {}), resultExpiresAt: null };
}

/** Lightweight caller inventory in creation order; listing never replays game history. */
export function listApiMatches(callerId: string) {
  sweepApiRecords();
  return [...records.values()].filter((record) => record.callerId === callerId).map((record) => {
    const match = getMatch(record.matchId);
    const result = record.result;
    return {
      matchId: record.matchId,
      lobbyId: record.lobbyId,
      status: result?.status ?? statusOf(match),
      createdAt: record.createdAt,
      startedAt: result?.startedAt ?? match?.createdAt ?? null,
      finishedAt: result?.finishedAt ?? match?.finishedAt ?? null,
      resultExpiresAt: result?.resultExpiresAt ?? null,
    };
  });
}

/** Active plus retained records, for `/server-stats` — what the record budget is being spent on. */
export function apiRecordCount(): number { return records.size; }

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
