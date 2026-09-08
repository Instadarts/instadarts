import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { WebSocket } from 'ws';
import { handleApi } from '../../src/server/api';
import { CONFIG } from '../../src/server/config';
import { ApiError, API_RETENTION_MS, createApiMatch, getApiMatch, reservedMatchId, sweepApiRecords } from '../../src/server/apiMatches';
import { handleClientLeave, handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { getClient, publicPlayers } from '../../src/server/connections';
import { deleteLobby, deleteMatch, getAllLobbies, getAllMatches, getLobby, getMatch } from '../../src/server/store';
import { sweepLifecycle, IDLE_TTL_MS, SUMMARY_TTL_MS, touch } from '../../src/server/lifecycle';
import { heldSeat } from '../../src/server/seats';
import { findPersonalInvite } from '../../src/server/invite';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { MAX_VISITS_PER_LEG, standingsOf } from '../../src/shared/matchFormat';
import type { ServerMessage } from '../../src/shared/protocol';
import '../../src/server/modes/registry';
import { allModes } from '../../src/server/modes/types';

vi.mock('../../src/server/config', async (original) => {
  const actual = await original<typeof import('../../src/server/config')>();
  return { ...actual, CONFIG: { ...actual.CONFIG,
    server: { ...actual.CONFIG.server, maxMatches: 3, apiKeys: [{ id: 'a', key: 'key-a' }, { id: 'b', key: 'key-b' }] },
    media: { ...actual.CONFIG.media, enabled: false },
  } };
});

const settings = { mode: 'x01', modeSettings: { startScore: 180, doubleOut: false } };
const request = (names = ['Same', 'Same']) => ({ settings, players: names.map((name) => ({ name })) });
const sockets: WebSocket[] = [];
let sequence = 0;
function connect() {
  const sessionId = `api-session-${++sequence}`;
  const received: ServerMessage[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (raw: string) => received.push(JSON.parse(raw)), close: vi.fn(), terminate: vi.fn() } as unknown as WebSocket;
  registerClient(ws, { sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null });
  sockets.push(ws);
  return {
    ws, sessionId, received,
    send(msg: object) { releaseRateLimit(sessionId, null); handleMessage(ws, JSON.stringify(msg)); },
    join(code: string) { this.send({ type: 'join_lobby', inviteCode: code }); },
    last<T extends ServerMessage['type']>(type: T) { return received.filter((m) => m.type === type).at(-1) as Extract<ServerMessage, { type: T }>; },
  };
}
function running(names = ['Same', 'Same']) {
  const created = createApiMatch('a', request(names));
  const players = created.players.map((p) => { const client = connect(); client.join(p.inviteCode); return client; });
  return { created, players };
}
function finishByScoring(client: ReturnType<typeof connect>) {
  for (let i = 0; i < 3; i++) client.send({ type: 'add_dart', dart: { x: 500_000, y: 726_000 } });
  client.send({ type: 'submit_visit' });
}

afterEach(() => {
  for (const ws of sockets.splice(0)) { handleClientLeave(ws); removeClient(ws); }
  const afterRooms = Date.now() + IDLE_TTL_MS + SUMMARY_TTL_MS + 1;
  sweepLifecycle(afterRooms);
  sweepLifecycle(afterRooms);
  sweepApiRecords(Infinity);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('managed invitations and spectator snapshots', () => {
  it('keeps duplicate names, UUID identity, input order, and settings defaults', () => {
    const created = createApiMatch('a', request());
    expect(created.players.map((p) => p.name)).toEqual(['Same', 'Same']);
    expect(new Set(created.players.map((p) => p.id)).size).toBe(2);
    for (const player of created.players) {
      expect(player.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(player.inviteCode).toMatch(/^[A-Z2-9]{6}$/);
    }
    expect(new Set(created.players.map((p) => p.inviteCode)).size).toBe(2);
    expect(created.settings.legsToWinSet).toBe(1);
    expect(getApiMatch('a', created.matchId).status).toBe('waiting');
  });

  it('creates and starts each installed mode with its effective defaults', () => {
    for (const mode of allModes()) {
      const created = createApiMatch('a', { settings: { mode: mode.id }, players: [{ name: 'Solo' }] });
      const player = connect(); player.join(created.players[0].inviteCode);
      expect(getMatch(created.matchId)?.settings).toEqual(created.settings);
      expect(player.last('match_started').match.id).toBe(created.matchId);
    }
  });

  it('rejects caller-supplied server-owned mode settings', () => {
    const created = createApiMatch('a', { settings: { mode: 'whac-a-mole' }, players: [{ name: 'Solo' }] });
    expect(created.settings.modeSettings.seed).toEqual(expect.any(Number));
    expect(() => createApiMatch('a', { settings: created.settings, players: [{ name: 'Solo' }] })).toThrow('Unknown field in settings.modeSettings');
  });

  it('watches the reserved ID, supports shared boards, and starts exactly once at capacity', () => {
    const created = createApiMatch('a', request(['Same', 'Same', 'Third']));
    createApiMatch('a', request());
    createApiMatch('a', request());
    const watcher = connect();
    watcher.send({ type: 'spectate', id: created.matchId });
    expect(watcher.last('lobby_state').lobby.id).toBe(created.lobbyId);
    const first = connect();
    first.join(created.players[1].inviteCode);
    first.join(created.players[1].inviteCode);
    first.join(created.players[0].inviteCode);
    const token = first.last('resume').token;
    expect(heldSeat(created.lobbyId, first.sessionId)?.seat.playerIds).toHaveLength(2);
    expect(watcher.last('lobby_state').lobby.joinedPlayerIds).toEqual(created.players.slice(0, 2).map((p) => p.id));
    expect(getMatch(created.matchId)).toBeUndefined();
    const third = connect();
    third.join(created.players[2].inviteCode);
    const match = getMatch(created.matchId)!;
    expect(getLobby(created.lobbyId)).toBeUndefined();
    expect(match.players.map((p) => p.id)).toEqual(created.players.map((p) => p.id));
    expect(publicPlayers(match.players).slice(0, 2).map((p) => p.boardId)).toEqual([created.players[0].id, created.players[0].id]);
    expect(first.last('resume')).toMatchObject({ matchId: created.matchId, token });
    expect(watcher.last('match_started').standings).toEqual(standingsOf([], match.settings));
    expect(watcher.received.filter((m) => m.type === 'match_started')).toHaveLength(1);
    expect(created.players.every((p) => !findPersonalInvite(p.inviteCode))).toBe(true);
    for (const observer of [first, watcher]) {
      const raw = JSON.stringify(observer.received.filter((m) => m.type === 'lobby_state' || m.type === 'match_started'));
      for (const p of created.players) expect(raw).not.toContain(p.inviteCode);
      expect(raw).not.toContain(first.sessionId);
      expect(raw).not.toContain('callerId');
    }
  });

  it('rejects competing or foreign claims without changing the existing seat', () => {
    const a = createApiMatch('a', request());
    const b = createApiMatch('b', request());
    const first = connect(); first.join(a.players[0].inviteCode);
    const second = connect(); second.join(a.players[0].inviteCode);
    expect(second.last('error').message).toContain('already joined');
    const before = first.last('resume');
    first.join(b.players[0].inviteCode);
    first.join('BADBAD');
    expect(getClient(first.ws)?.lobbyId).toBe(a.lobbyId);
    expect(first.last('resume')).toEqual(before);
    expect(getLobby(a.lobbyId)?.players).toHaveLength(2);
  });

  it('releases shared players back to waiting and lets another browser reclaim their codes', () => {
    const created = createApiMatch('a', request(['A', 'B', 'C']));
    const first = connect();
    first.join(created.players[0].inviteCode); first.join(created.players[1].inviteCode);
    first.send({ type: 'leave_match' });
    expect(getApiMatch('a', created.matchId).joinedPlayerIds).toEqual([]);
    expect(getLobby(created.lobbyId)?.players).toHaveLength(3);
    const next = connect();
    next.join(created.players[0].inviteCode); next.join(created.players[1].inviteCode); next.join(created.players[2].inviteCode);
    expect(getMatch(created.matchId)?.players).toHaveLength(3);
  });

  it('starts an accepted final join even if publishing crosses the old idle deadline', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const created = createApiMatch('a', request(['Solo']));
    getLobby(created.lobbyId)!.expiresAt = now + 1;
    const player = connect();
    const send = player.ws.send;
    vi.spyOn(player.ws, 'send').mockImplementation((...args: any[]) => {
      send.call(player.ws, args[0], {});
      vi.setSystemTime(now + 2);
    });
    player.join(created.players[0].inviteCode);
    expect(getMatch(created.matchId)?.status).toBe('in_progress');
  });

  it('does not count a closed socket as ready and starts when its seat reconnects', () => {
    const created = createApiMatch('a', request());
    const first = connect(); first.join(created.players[0].inviteCode);
    const resume = first.last('resume');
    Object.assign(first.ws, { readyState: 3 });
    const second = connect(); second.join(created.players[1].inviteCode);
    expect(getMatch(created.matchId)).toBeUndefined();
    const restored = connect(); restored.send({ ...resume, type: 'reconnect' });
    expect(getMatch(created.matchId)?.status).toBe('in_progress');
    handleClientLeave(first.ws);
    expect(getMatch(created.matchId)?.departed).toEqual([]);
  });

  it('resumes a carried seat if the browser missed the automatic start notification', () => {
    const created = createApiMatch('a', request());
    const first = connect(); first.join(created.players[0].inviteCode);
    const lobbyResume = first.last('resume');
    const second = connect(); second.join(created.players[1].inviteCode);
    const restored = connect(); restored.send({ ...lobbyResume, type: 'reconnect' });
    expect(restored.last('resume')).toMatchObject({ matchId: created.matchId, token: lobbyResume.token });
    expect(restored.last('match_state').yourPlayerIds).toEqual([created.players[0].id]);
    handleClientLeave(first.ws);
    expect(getMatch(created.matchId)?.departed).toEqual([]);
  });

  it('rejects every roster/settings/start command and player rematches', () => {
    const created = createApiMatch('a', request());
    const first = connect(); first.join(created.players[0].inviteCode);
    const before = structuredClone(getLobby(created.lobbyId));
    for (const type of ['add_local_player', 'remove_player', 'set_player_name', 'update_settings', 'reorder_player', 'start_match']) {
      first.send({ type, playerId: created.players[0].id, playerName: 'Changed', settings: { mode: 'x01' }, direction: 'down' });
      expect(first.last('error').message).toContain('API creator');
      expect(getLobby(created.lobbyId)).toEqual(before);
    }
    const second = connect(); second.join(created.players[1].inviteCode);
    finishByScoring(first);
    first.send({ type: 'rematch_vote', playerId: created.players[0].id, answer: 'accepted' });
    expect(first.last('error').message).toContain('API creator');
    expect(getMatch(created.matchId)?.rematchVotes).toEqual({});
  });
});

describe('retained results', () => {
  it.each(['waiting', 'in_progress'] as const)('reclaims an orphaned %s record and its capacity', (status) => {
    const created = status === 'waiting' ? createApiMatch('a', request()) : running().created;
    for (let i = 1; i < CONFIG.server.maxMatches; i++) createApiMatch('a', request());
    if (status === 'waiting') deleteLobby(created.lobbyId);
    else deleteMatch(created.matchId);
    // Bypass the normal lifecycle intentionally: the orphan has no result or retention deadline.
    expect(reservedMatchId(created.lobbyId)).toBe(created.matchId);
    sweepApiRecords();
    expect(reservedMatchId(created.lobbyId)).toBeUndefined();
    expect(() => getApiMatch('a', created.matchId)).toThrow('Match not found');
    expect(() => createApiMatch('a', request())).not.toThrow();
  });

  it.each(['waiting', 'in_progress'] as const)('preserves a %s room kept active for more than 48 hours', (status) => {
    vi.useFakeTimers();
    const created = status === 'waiting' ? createApiMatch('a', request()) : running().created;
    vi.setSystemTime(Date.now() + 3 * API_RETENTION_MS);
    touch((status === 'waiting' ? getLobby(created.lobbyId) : getMatch(created.matchId))!);
    sweepLifecycle();
    expect(reservedMatchId(created.lobbyId)).toBe(created.matchId);
    expect(getApiMatch('a', created.matchId).status).toBe(status);
  });

  it('keeps returned top-level fields separate from the archived result', () => {
    const { created, players } = running();
    finishByScoring(players[0]);
    const result = getApiMatch('a', created.matchId, true);
    result.winnerId = null;
    result.history = undefined;
    const next = getApiMatch('a', created.matchId, true);
    expect(next.winnerId).toBe(created.players[0].id);
    expect(next.history?.legs).toHaveLength(1);
  });

  it('pushes scoring and completion, resubscribes with a full snapshot, and retains immutable history for 24 hours', () => {
    const { created, players } = running();
    const watcher = connect(); watcher.send({ type: 'spectate', id: created.matchId });
    players[0].send({ type: 'add_dart', dart: { x: 500_000, y: 726_000 } });
    expect(watcher.last('match_state').match.currentVisit?.darts).toHaveLength(1);
    watcher.send({ type: 'leave_match' });
    watcher.send({ type: 'spectate', id: created.matchId });
    expect(watcher.last('match_state').match.currentVisit?.darts).toHaveLength(1);
    players[0].send({ type: 'undo_dart' });
    finishByScoring(players[0]);
    expect(watcher.last('match_state').match.status).toBe('finished');
    const result = structuredClone(getApiMatch('a', created.matchId, true));
    expect(result.winnerId).toBe(created.players[0].id);
    expect(result.history?.legs[0].visits[0].darts).toHaveLength(3);
    expect(result.standings.setWins[result.winnerId!]).toBe(1);
    expect(getApiMatch('a', created.matchId).history).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('sessionId');
    for (const p of players) p.send({ type: 'leave_match' });
    sweepLifecycle(result.roomExpiresAt + 1);
    expect(getMatch(created.matchId)).toBeUndefined();
    expect(watcher.last('match_closed')).toBeDefined();
    expect(getApiMatch('a', created.matchId, true)).toEqual(result);
    expect(result.resultExpiresAt).toBe(result.finishedAt! + API_RETENTION_MS);
    sweepApiRecords(result.resultExpiresAt! - 1);
    expect(getApiMatch('a', created.matchId).status).toBe('finished');
    sweepApiRecords(result.resultExpiresAt!);
    expect(() => getApiMatch('a', created.matchId)).toThrow('Match not found');
  });

  it.each(['departure', 'idle', 'visit-limit'] as const)('archives cancellation through %s', (reason) => {
    const { created, players } = running(['Solo']);
    if (reason === 'departure') players[0].send({ type: 'leave_match' });
    if (reason === 'idle') sweepLifecycle(getMatch(created.matchId)!.expiresAt + 1);
    if (reason === 'visit-limit') {
      getMatch(created.matchId)!.visits = Array.from({ length: MAX_VISITS_PER_LEG - 1 }, (_, i) => ({ playerId: created.players[0].id, darts: [], visitNumber: i + 1, voided: false }));
      players[0].send({ type: 'submit_visit' });
    }
    expect(getApiMatch('a', created.matchId).status).toBe('cancelled');
    expect(getApiMatch('a', created.matchId).winnerId).toBeNull();
  });

  it('archives a departure win and expired lobbies, retires codes, and enforces the independent record budget', () => {
    const { created, players } = running();
    players[0].send({ type: 'leave_match' });
    expect(getApiMatch('a', created.matchId).winnerId).toBe(created.players[1].id);
    const waiting = createApiMatch('a', request());
    const another = createApiMatch('b', request());
    sweepLifecycle(Date.now() + IDLE_TTL_MS + SUMMARY_TTL_MS);
    expect(getAllLobbies().size + getAllMatches().size).toBe(0);
    expect(getApiMatch('a', waiting.matchId).status).toBe('expired');
    expect(findPersonalInvite(waiting.players[0].inviteCode)).toBeUndefined();
    expect(() => createApiMatch('a', request())).toThrow('capacity');
    expect(() => getApiMatch('a', another.matchId)).toThrow('Match not found');
  });
});

describe('HTTP match API', () => {
  let base: string;
  const server = createServer((req, res) => { void handleApi(req, res).then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const call = (path = '/api/v1/matches', init: RequestInit = {}, key = 'key-a') => fetch(base + path, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...init.headers },
  });

  it('creates, authenticates, isolates callers, and returns JSON errors and no-store responses', async () => {
    const response = await call(undefined, { method: 'POST', body: JSON.stringify(request()) });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const created = await response.json();
    expect((await call(`/api/v1/matches/${created.matchId}`)).status).toBe(200);
    expect((await call(`/api/v1/matches/${created.matchId}`, {}, 'key-b')).status).toBe(404);
    const unauthorized = await call(`/api/v1/matches/${created.matchId}`, {}, 'wrong');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
    expect(unauthorized.headers.get('content-type')).toContain('application/json');
    expect((await call('/api/unknown')).status).toBe(404);
    expect((await call(`/api/v1/matches/${created.matchId}?includeHistory=maybe`)).status).toBe(400);
    expect((await call(`/api/v1/matches/${created.matchId}?includeHistory=true`).then((r) => r.json())).history).toEqual({ legs: [], visits: [] });
  });

  it('rejects malformed or oversized JSON and unsupported content types without creating rooms', async () => {
    for (const [body, expected] of [['{', 400], [' '.repeat(16 * 1024 + 1), 413]] as const) {
      const response = await call(undefined, { method: 'POST', body });
      expect(response.status).toBe(expected);
      expect((await response.json()).error.code).toBeTruthy();
    }
    expect((await call(undefined, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect(getAllLobbies().size).toBe(0);
  });

  it('returns 503 when the creation budget is full', async () => {
    for (let i = 0; i < CONFIG.server.maxMatches; i++) createApiMatch('a', request());
    const response = await call(undefined, { method: 'POST', body: JSON.stringify(request()) });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('capacity_exceeded');
  });

  it('is disabled without keys', async () => {
    const keys = CONFIG.server.apiKeys;
    CONFIG.server.apiKeys = [];
    try { expect((await call()).status).toBe(404); }
    finally { CONFIG.server.apiKeys = keys; }
  });

  it.each([
    {}, { settings: { mode: 'unknown' }, players: [{ name: 'A' }] },
    { settings, players: [] }, { settings, players: [{ name: '' }] },
    { settings, players: Array.from({ length: 6 }, () => ({ name: 'A' })) },
    { settings: { ...settings, legsToWinSet: 11 }, players: [{ name: 'A' }] },
    { settings: { mode: 'x01', modeSettings: { doubleOut: 'false' } }, players: [{ name: 'A' }] },
    { settings: { mode: 'x01', modeSettings: { typo: true } }, players: [{ name: 'A' }] },
  ])('strictly rejects invalid creation %#', async (body) => {
    expect(() => createApiMatch('a', body)).toThrow(ApiError);
    expect((await call(undefined, { method: 'POST', body: JSON.stringify(body) })).status).toBe(400);
    expect(getAllLobbies().size).toBe(0);
  });
});
