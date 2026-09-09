import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { WebSocket } from 'ws';
import { handleApi } from '../../src/server/api';
import { CONFIG } from '../../src/server/config';
import { ApiError, API_RETENTION_MS, createApiMatch, deleteApiMatch, getApiMatch, listApiMatches, reservedMatchId, sweepApiRecords } from '../../src/server/apiMatches';
import { handleClientLeave, handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { getClient, publicPlayers } from '../../src/server/connections';
import { createLobby, deleteLobby, deleteMatch, getAllLobbies, getAllMatches, getLobby, getMatch, maxPlayersFor } from '../../src/server/store';
import { sweepLifecycle, IDLE_TTL_MS, SUMMARY_TTL_MS, touch } from '../../src/server/lifecycle';
import { heldSeat } from '../../src/server/seats';
import { findPersonalInvite } from '../../src/server/invite';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { MAX_VISITS_PER_LEG, standingsOf } from '../../src/shared/matchFormat';
import type { ServerMessage } from '../../src/shared/protocol';
import type { ModeDescriptor, ModeSettings } from '../../src/shared/settings';
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

  it('accepts a returned settings bag back and still chooses server-owned values itself', () => {
    // Echoing the creation response is the obvious thing to do with it, so it must work for every
    // installed mode on every build: `seed` and production x01's `stats` are in a mode's `defaults`
    // but not its `fields`, and were the difference between a dev server and a production one.
    for (const mode of allModes()) {
      const created = createApiMatch('a', { settings: { mode: mode.id }, players: [{ name: 'Solo' }] });
      const echoed = createApiMatch('a', { settings: created.settings, players: [{ name: 'Solo' }] });
      // Every editable field survives the round trip; server-owned ones are chosen afresh.
      for (const { key } of mode.fields) expect(echoed.settings.modeSettings[key]).toEqual(created.settings.modeSettings[key]);
      expect(Object.keys(echoed.settings.modeSettings).sort()).toEqual(Object.keys(created.settings.modeSettings).sort());
      deleteLobby(created.lobbyId);
      deleteLobby(echoed.lobbyId);
    }
    // Recognised, not obeyed: a caller cannot pin a server-owned value by handing one back.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const seeded = createApiMatch('a', { settings: { mode: 'whac-a-mole' }, players: [{ name: 'Solo' }] });
    expect(seeded.settings.modeSettings.seed).toBe(1073741823);
    random.mockReturnValue(0.25);
    const pinned = createApiMatch('a', { settings: { mode: 'whac-a-mole', modeSettings: { seed: 9999 } }, players: [{ name: 'Solo' }] });
    expect(pinned.settings.modeSettings.seed).toBe(536870911);
    // One generated default per creation, reused for validation and the stored settings.
    expect(random).toHaveBeenCalledTimes(2);
  });

  it('names an unknown settings key rather than only the object holding it', () => {
    expect(() => createApiMatch('a', { settings: { mode: 'x01', modeSettings: { typo: 1 } }, players: [{ name: 'A' }] }))
      .toThrow('Unknown field settings.modeSettings.typo');
    expect(() => createApiMatch('a', { settings: { mode: 'x01' }, players: [{ name: 'A' }], extra: 1 }))
      .toThrow('Unknown field request.extra');
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
    first.send({ type: 'join_lobby', inviteCode: b.players.map((p) => p.inviteCode) });
    first.join('BADBAD');
    expect(getClient(first.ws)?.lobbyId).toBe(a.lobbyId);
    expect(first.last('resume')).toEqual(before);
    expect(getLobby(a.lobbyId)?.players).toHaveLength(2);
  });

  it('claims a group together, preserves repeated claims, and starts once after the final group', () => {
    const created = createApiMatch('a', request(['A', 'B', 'C']));
    const watcher = connect(); watcher.send({ type: 'spectate', id: created.matchId });
    const player = connect();
    const codes = created.players.map((p) => p.inviteCode);
    player.send({ type: 'join_lobby', inviteCode: [codes[1], codes[0], codes[1]] });
    const resume = player.last('resume');
    expect(player.last('lobby_state').yourPlayerIds).toEqual([created.players[1].id, created.players[0].id]);
    expect(watcher.received.filter((m) => m.type === 'lobby_state')).toHaveLength(2);
    player.send({ type: 'join_lobby', inviteCode: [codes[0], codes[1]] });
    expect(player.last('resume')).toEqual(resume);
    expect(getApiMatch('a', created.matchId).joinedPlayerIds).toEqual(created.players.slice(0, 2).map((p) => p.id));
    const restored = connect(); restored.send({ ...resume, type: 'reconnect' });
    restored.send({ type: 'join_lobby', inviteCode: [codes[1], codes[2], codes[2]] });
    const match = getMatch(created.matchId)!;
    expect(match.players.map((p) => p.id)).toEqual(created.players.map((p) => p.id));
    expect(publicPlayers(match.players).map((p) => p.boardId)).toEqual(created.players.map(() => created.players[0].id));
    expect(restored.last('match_started').yourPlayerIds).toHaveLength(3);
    expect(watcher.received.filter((m) => m.type === 'match_started')).toHaveLength(1);
    expect(restored.received.filter((m) => m.type === 'error')).toEqual([]);
  });

  it.each(['unknown', 'foreign', 'claimed', 'ordinary', 'expired', 'empty', 'invalid-type', 'too-many'] as const)(
    'rejects a %s group without changing any claims or the existing seat', (reason) => {
      const created = createApiMatch('a', request(['A', 'B', 'C']));
      const player = connect(); player.join(created.players[0].inviteCode);
      const busy = connect(); busy.join(created.players[1].inviteCode);
      const other = createApiMatch('b', request());
      const host = connect(); host.send({ type: 'create_lobby', acceptsJoins: true });
      const available = created.players[2].inviteCode;
      const batches = {
        unknown: [available, 'BADBAD'],
        foreign: [available, other.players[0].inviteCode],
        claimed: [available, created.players[1].inviteCode],
        ordinary: [available, host.last('lobby_state').lobby.inviteCode],
        expired: [available],
        empty: [],
        'invalid-type': [available, 123],
        'too-many': Array(CONFIG.server.maxPlayersPerMatch + 1).fill(available),
      };
      if (reason === 'expired') getLobby(created.lobbyId)!.expiresAt = Date.now() - 1;
      // Participant input can renew the idle deadline even when admission is refused.
      const { expiresAt: _deadline, ...before } = structuredClone(getLobby(created.lobbyId)!);
      const resume = player.last('resume');
      player.send({ type: 'join_lobby', inviteCode: batches[reason] });
      expect(player.last('error')).toBeDefined();
      expect(player.last('resume')).toEqual(resume);
      expect(getLobby(created.lobbyId)).toMatchObject(before);
      expect(getClient(player.ws)?.lobbyId).toBe(created.lobbyId);
      expect(getMatch(created.matchId)).toBeUndefined();
    },
  );

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

  it.each(['waiting', 'in_progress'] as const)('deletes a %s match, tells the room, and frees its record', (status) => {
    const { created, players } = status === 'waiting'
      ? { created: createApiMatch('a', request()), players: [connect()] }
      : running();
    if (status === 'waiting') players[0].join(created.players[0].inviteCode);
    const final = deleteApiMatch('a', created.matchId);

    // The caller is handed the whole match, history included: retention is not offered afterwards.
    expect(final.status).toBe('cancelled');
    expect(final.resultExpiresAt).toBeNull();
    expect(final.history).toBeDefined();
    expect(final.players.map((p) => p.id)).toEqual(created.players.map((p) => p.id));

    // The people in it were told, through the ordinary ending for that stage.
    expect(players[0].last(status === 'waiting' ? 'lobby_abandoned' : 'match_finished')).toBeDefined();
    expect(getAllLobbies().size + [...getAllMatches().values()].filter((m) => m.status === 'in_progress').length).toBe(0);
    expect(findPersonalInvite(created.players[0].inviteCode)).toBeUndefined();

    // And the record is gone, not retained: a second delete and a read both 404.
    expect(() => getApiMatch('a', created.matchId)).toThrow('Match not found');
    expect(() => deleteApiMatch('a', created.matchId)).toThrow('Match not found');
    expect(listApiMatches('a')).toEqual([]);
    expect(reservedMatchId(created.lobbyId)).toBeUndefined();
  });

  it('deletes a terminal record without rewriting the outcome it already had', () => {
    const { created, players } = running();
    finishByScoring(players[0]);
    expect(getApiMatch('a', created.matchId).status).toBe('finished');
    const final = deleteApiMatch('a', created.matchId);
    // A match that really was won stays won; only a room still live is called off.
    expect(final.status).toBe('finished');
    expect(final.winnerId).toBe(created.players[0].id);
    expect(final.resultExpiresAt).toBeNull();
    expect(() => getApiMatch('a', created.matchId)).toThrow('Match not found');
  });

  it('refuses another caller and frees a full record budget', () => {
    const created = createApiMatch('a', request());
    for (let i = 1; i < CONFIG.server.maxMatches; i++) createApiMatch('a', request());
    expect(() => deleteApiMatch('b', created.matchId)).toThrow('Match not found');
    expect(() => createApiMatch('a', request())).toThrow('capacity');
    // Deleting is the one thing that returns a record early, which is what makes it a remedy here.
    deleteApiMatch('a', created.matchId);
    expect(() => createApiMatch('a', request())).not.toThrow();
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

  it('discovers all installed modes with defaults accepted by creation and effective player limits', async () => {
    const response = await call('/api/v1/modes');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const catalog = await response.json();
    expect(catalog.modes.map((mode: ModeDescriptor) => mode.id)).toEqual(allModes().map((mode) => mode.id));
    expect(catalog.matchFields.map((field: { key: string }) => field.key).sort()).toEqual(Object.keys(catalog.matchDefaults).sort());
    for (const mode of catalog.modes) {
      expect(Object.keys(mode.defaults).sort()).toEqual(mode.fields.map((field: { key: string }) => field.key).sort());
      expect(mode.effectiveMaxPlayers).toBe(maxPlayersFor(mode.id));
      expect(mode.defaults).not.toHaveProperty('seed');
      const created = await call(undefined, { method: 'POST', body: JSON.stringify({
        settings: { mode: mode.id, modeSettings: mode.defaults, ...catalog.matchDefaults }, players: [{ name: 'Solo' }],
      }) });
      expect(created.status).toBe(201);
      expect((await created.json()).settings.modeSettings).toMatchObject(mode.defaults);
    }
  });

  it.each(allModes().map((mode) => mode.id))('plays %s through multiple legs/sets, reconnects, and retains its full result', async (mode) => {
    const smallSettings: Record<string, ModeSettings> = {
      x01: { startScore: 180, doubleOut: false },
      'count-up': { targetScore: 60 },
      'whac-a-mole': { turns: 5 },
    };
    const response = await call(undefined, { method: 'POST', body: JSON.stringify({
      settings: { mode, modeSettings: smallSettings[mode], legsToWinSet: 2, setsToWinMatch: 2 }, players: [{ name: 'Solo' }],
    }) });
    expect(response.status).toBe(201);
    const created = await response.json();
    if (mode === 'whac-a-mole') expect(created.settings.modeSettings.seed).toEqual(expect.any(Number));
    // Catalog reads and new connections may generate candidate defaults, never change this match's seed.
    await call('/api/v1/modes');
    const watcher = connect(); watcher.send({ type: 'spectate', id: created.matchId });
    const player = connect(); player.join(created.players[0].inviteCode);
    expect(watcher.last('match_started').match.settings).toEqual(created.settings);
    player.send({ type: 'add_dart', dart: { x: 500_000, y: 726_000 } });
    const beforeReconnect = watcher.last('match_state');
    expect(beforeReconnect.match.currentVisit?.darts).toHaveLength(1);
    watcher.send({ type: 'spectate', id: created.matchId });
    expect(watcher.last('match_state').view).toEqual(beforeReconnect.view);
    const restored = connect(); restored.send({ ...player.last('resume'), type: 'reconnect' });
    expect(restored.last('match_state').view).toEqual(beforeReconnect.view);
    restored.send({ type: 'undo_dart' });
    for (let visits = 0; visits < 40 && getMatch(created.matchId)!.status !== 'finished'; visits++) {
      if (mode === 'x01') finishByScoring(restored);
      else {
        if (mode === 'count-up') restored.send({ type: 'add_dart', dart: { x: 500_000, y: 726_000 } });
        restored.send({ type: 'submit_visit' });
      }
    }
    const terminal = watcher.last('match_state');
    expect(terminal.match.status).toBe('finished');
    expect(terminal.match.settings).toEqual(created.settings);
    expect(terminal.match.winnerId).toBe(created.players[0].id);
    expect(terminal.standings.setWins[created.players[0].id]).toBe(2);
    expect(restored.received.filter((message) => message.type === 'error')).toEqual([]);
    sweepLifecycle(terminal.match.expiresAt + 1);
    expect(getMatch(created.matchId)).toBeUndefined();
    const result = await call(`/api/v1/matches/${created.matchId}?includeHistory=true`).then((r) => r.json());
    expect(result.settings).toEqual(created.settings);
    expect(result.playerScores).toEqual(terminal.view.playerScores);
    expect(result.standings).toEqual(terminal.standings);
    expect(result.history.legs).toEqual(terminal.match.legs);
    expect(result.history.legs).toHaveLength(4);
  });

  it('lists only caller-owned matches in creation order through play, cleanup, and retention expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const list = async (key = 'key-a') => {
      const result = await call('/api/v1/matches', {}, key).then((r) => r.json());
      for (const entry of result.matches) {
        const detail = await call(`/api/v1/matches/${entry.matchId}`, {}, key).then((r) => r.json());
        expect(entry.status).toBe(detail.status);
      }
      return result;
    };
    expect(await list()).toEqual({ matches: [] });
    const ordinary = createLobby();
    expect(await list()).toEqual({ matches: [] });
    deleteLobby(ordinary.id);
    const waiting = createApiMatch('a', request());
    const { created, players } = running(['Solo']);
    const other = createApiMatch('b', request());
    const initial = await list();
    expect(initial.matches).toEqual([
      { matchId: waiting.matchId, lobbyId: waiting.lobbyId, status: 'waiting', createdAt: expect.any(Number), startedAt: null, finishedAt: null, resultExpiresAt: null },
      { matchId: created.matchId, lobbyId: created.lobbyId, status: 'in_progress', createdAt: expect.any(Number), startedAt: expect.any(Number), finishedAt: null, resultExpiresAt: null },
    ]);
    expect((await list('key-b')).matches.map((m: { matchId: string }) => m.matchId)).toEqual([other.matchId]);
    finishByScoring(players[0]);
    expect((await list()).matches.map((m: { status: string }) => m.status)).toEqual(['waiting', 'finished']);
    sweepLifecycle(Date.now() + IDLE_TTL_MS + SUMMARY_TTL_MS);
    const retained = (await list()).matches;
    expect(retained.map((m: { status: string }) => m.status)).toEqual(['expired', 'finished']);
    for (const entry of retained) expect(entry.resultExpiresAt).toBe(entry.finishedAt + API_RETENTION_MS);
    expect(getApiMatch('a', waiting.matchId).status).toBe('expired');
    vi.setSystemTime(Math.max(...retained.map((m: { resultExpiresAt: number }) => m.resultExpiresAt)));
    expect(await list()).toEqual({ matches: [] });
  });

  it('preserves cancellation status through cleanup and drops orphaned rooms', async () => {
    const { created, players } = running(['Solo']);
    players[0].send({ type: 'leave_match' });
    const orphan = createApiMatch('a', request());
    deleteLobby(orphan.lobbyId);
    const response = await call();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const listed = await response.json();
    expect(listed.matches).toEqual([expect.objectContaining({ matchId: created.matchId, status: 'cancelled' })]);
    expect(getApiMatch('a', created.matchId).status).toBe('cancelled');
    sweepLifecycle(getMatch(created.matchId)!.expiresAt + 1);
    expect(getMatch(created.matchId)).toBeUndefined();
    expect(await call().then((r) => r.json())).toEqual(listed);
    expect((await call(`/api/v1/matches/${created.matchId}`).then((r) => r.json())).status).toBe('cancelled');
  });

  it.each(['/api/v1/matches', '/api/v1/modes'])('authenticates and disables discovery at %s', async (path) => {
    const unauthorized = await call(path, {}, 'wrong');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('cache-control')).toBe('no-store');
    // A path that exists says which methods it takes; only an unknown path is a 404.
    const wrongMethod = await call(path, { method: 'PUT' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe(path === '/api/v1/modes' ? 'GET' : 'GET, POST');
    expect((await wrongMethod.json()).error.code).toBe('method_not_allowed');
    const keys = CONFIG.server.apiKeys;
    CONFIG.server.apiKeys = [];
    try { expect((await call(path)).status).toBe(404); }
    finally { CONFIG.server.apiKeys = keys; }
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

  it('deletes over HTTP, returning the final state once and 404 thereafter', async () => {
    const created = await (await call(undefined, { method: 'POST', body: JSON.stringify(request()) })).json();
    const response = await call(`/api/v1/matches/${created.matchId}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const final = await response.json();
    // Never a summary: this is the last look anyone gets, so history is not opt-in here.
    expect(final).toMatchObject({ matchId: created.matchId, status: 'cancelled', resultExpiresAt: null });
    expect(final.history).toEqual({ legs: [], visits: [] });
    expect((await call(`/api/v1/matches/${created.matchId}`, { method: 'DELETE' })).status).toBe(404);
    expect((await call(`/api/v1/matches/${created.matchId}`)).status).toBe(404);
  });

  it('answers a wrong method with the ones a path does take', async () => {
    const created = await (await call(undefined, { method: 'POST', body: JSON.stringify(request()) })).json();
    const response = await call(`/api/v1/matches/${created.matchId}`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, DELETE');
    // An unknown path is still absent rather than wrongly addressed.
    expect((await call('/api/v1/nothing', { method: 'DELETE' })).status).toBe(404);
  });

  it('rejects unknown query parameters as strictly as unknown body fields', async () => {
    const created = await (await call(undefined, { method: 'POST', body: JSON.stringify(request()) })).json();
    for (const path of ['/api/v1/modes?bogus=1', '/api/v1/matches?includeHistory=true', `/api/v1/matches/${created.matchId}?bogus=1`]) {
      const response = await call(path);
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toContain('Unknown query parameter');
    }
    expect((await call(`/api/v1/matches/${created.matchId}?includeHistory=true`)).status).toBe(200);
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
