import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { clickT20, submitVisit } from './appHelpers';

const headers = { Authorization: 'Bearer instadarts-e2e-api-key' };
const settings = { mode: 'x01', modeSettings: { startScore: 180, doubleOut: false } };

test('API invitations lock the roster, share a board, and push spectator results', async ({ page, browser, request, baseURL }) => {
  const response = await request.post('/api/v1/matches', { headers, data: { settings, players: [{ name: 'Same' }, { name: 'Same' }, { name: 'Third' }] } });
  expect(response.status()).toBe(201);
  const created = await response.json();
  const wsURL = new URL('/ws', baseURL);
  wsURL.protocol = wsURL.protocol === 'https:' ? 'wss:' : 'ws:';
  const received: any[] = [];
  const watcher = new WebSocket(wsURL);
  watcher.on('message', (data) => received.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { watcher.once('open', resolve); watcher.once('error', reject); });
  const spectatorContext = await browser.newContext();
  const otherContext = await browser.newContext();
  try {
    watcher.send(JSON.stringify({ type: 'spectate', id: created.matchId }));
    await expect.poll(() => received.some((m) => m.type === 'lobby_state')).toBe(true);
    const spectator = await spectatorContext.newPage();
    await spectator.goto(`/spectate/${created.matchId}`);
    await expect(spectator.getByText('The match starts automatically when all players have joined')).toBeVisible();
    await page.goto(`/lobby/join/${created.players[0].inviteCode}`);
    await expect(page).toHaveURL(new RegExp(`/lobby/${created.lobbyId}$`));
    await expect(page.getByRole('button', { name: 'Start Match', exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'New player' })).toHaveCount(0);
    await expect(page.getByTitle('Remove player')).toHaveCount(0);
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await page.getByLabel('Player invite code').fill('BADBAD');
    await page.getByRole('button', { name: 'Add player by invite code' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Use a player invite code' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/lobby/${created.lobbyId}$`));
    await page.getByLabel('Player invite code').fill(created.players[1].inviteCode);
    await page.getByRole('button', { name: 'Add player by invite code' }).click();
    await expect(page.getByText('2/3 joined')).toBeVisible();
    await page.reload();
    await expect(page.getByText('2/3 joined')).toBeVisible();
    const other = await otherContext.newPage();
    await other.goto(`/lobby/join/${created.players[2].inviteCode}`);
    await expect(page).toHaveURL(new RegExp(`/match/${created.matchId}$`));
    await expect(other).toHaveURL(new RegExp(`/match/${created.matchId}$`));
    await expect(spectator).toHaveURL(new RegExp(`/spectate/${created.matchId}$`));
    for (let i = 0; i < 3; i++) await clickT20(page);
    await submitVisit(page);
    await expect.poll(() => received.some((m) => m.type === 'match_state' && m.match.status === 'finished')).toBe(true);
    const terminal = received.filter((m) => m.type === 'match_state' && m.match.status === 'finished').at(-1);
    expect(terminal.match.winnerId).toBe(created.players[0].id);
    expect(terminal.standings.setWins[created.players[0].id]).toBe(1);
    expect(terminal.match.legs[0].visits[0].darts).toHaveLength(3);
    await expect(page.getByText('Play again?', { exact: true })).toHaveCount(0);
    const result = await request.get(`/api/v1/matches/${created.matchId}?includeHistory=true`, { headers });
    expect((await result.json()).history.legs).toEqual(terminal.match.legs);
  } finally {
    watcher.close();
    await spectatorContext.close();
    await otherContext.close();
  }
});

test('a single-player invitation navigates directly into its automatic match', async ({ page, request }) => {
  const response = await request.post('/api/v1/matches', { headers, data: { settings, players: [{ name: 'Solo' }] } });
  const created = await response.json();
  await page.goto(`/lobby/join/${created.players[0].inviteCode}`);
  await expect(page).toHaveURL(new RegExp(`/match/${created.matchId}$`));
  await expect(page.getByTestId('dartboard')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('dartboard')).toBeVisible();
});

test('a shared-board link claims multiple players together and preserves them across reloads', async ({ page, browser, request }) => {
  const response = await request.post('/api/v1/matches', { headers, data: { settings, players: ['A', 'B', 'C', 'D'].map((name) => ({ name })) } });
  expect(response.status()).toBe(201);
  const created = await response.json();
  const sharedLink = `/lobby/join/${[2, 0, 1].map((i) => created.players[i].inviteCode.toLowerCase()).join('/')}`;
  await page.goto(sharedLink);
  await expect(page).toHaveURL(new RegExp(`/lobby/${created.lobbyId}$`));
  await expect(page.getByText('3/4 joined')).toBeVisible();
  await page.reload();
  await expect(page.getByText('3/4 joined')).toBeVisible();
  // Reopening the same link uses the saved seat and does not lose any of its players.
  await page.goto(sharedLink);
  await expect(page).toHaveURL(new RegExp(`/lobby/${created.lobbyId}$`));
  await expect(page.getByText('3/4 joined')).toBeVisible();
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto(`/lobby/join/${created.players[3].inviteCode}`);
    await expect(page).toHaveURL(new RegExp(`/match/${created.matchId}$`));
    await page.reload();
    await expect(page.getByTestId('dartboard')).toBeVisible();
    const state = await request.get(`/api/v1/matches/${created.matchId}`, { headers }).then((r) => r.json());
    expect(state.players.map((p: { boardId: string }) => p.boardId)).toEqual([
      created.players[0].id, created.players[0].id, created.players[0].id, created.players[3].id,
    ]);
    for (let i = 0; i < 3; i++) await clickT20(page);
    await submitVisit(page);
    await expect(page.getByText('Play again?', { exact: true })).toHaveCount(0);
    const result = await request.get(`/api/v1/matches/${created.matchId}`, { headers }).then((r) => r.json());
    expect(result.winnerId).toBe(created.players[0].id);
  } finally {
    await otherContext.close();
  }
});

test('a link containing the full roster starts immediately, including repeated codes', async ({ page, request }) => {
  const response = await request.post('/api/v1/matches', { headers, data: { settings, players: [{ name: 'A' }, { name: 'B' }] } });
  const created = await response.json();
  await page.goto(`/lobby/join/${[1, 0, 1].map((i) => created.players[i].inviteCode).join('/')}`);
  await expect(page).toHaveURL(new RegExp(`/match/${created.matchId}$`));
  await expect(page.getByTestId('dartboard')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('dartboard')).toBeVisible();
  const result = await request.get(`/api/v1/matches/${created.matchId}`, { headers }).then((r) => r.json());
  expect(result.status).toBe('in_progress');
  expect(result.players.map((p: { boardId: string }) => p.boardId)).toEqual([created.players[0].id, created.players[0].id]);
});

test('invalid shared links claim no players and preserve an existing seat', async ({ page, request }) => {
  const response = await request.post('/api/v1/matches', { headers, data: { settings, players: ['A', 'B', 'C'].map((name) => ({ name })) } });
  const created = await response.json();
  const state = () => request.get(`/api/v1/matches/${created.matchId}`, { headers }).then((r) => r.json());
  await page.goto(`/lobby/join/${created.players[0].inviteCode}/BADBAD`);
  await expect(page).toHaveURL('/');
  expect((await state()).joinedPlayerIds).toEqual([]);
  await page.goto(`/lobby/join/${created.players[0].inviteCode}`);
  await expect(page.getByText('1/3 joined')).toBeVisible();
  await page.goto(`/lobby/join/${created.players[1].inviteCode}/BADBAD`);
  await expect(page).toHaveURL(new RegExp(`/lobby/${created.lobbyId}$`));
  await expect(page.getByText('1/3 joined')).toBeVisible();
  expect((await state()).joinedPlayerIds).toEqual([created.players[0].id]);
  await page.goto(`/lobby/join/${created.players[1].inviteCode}/${created.players[2].inviteCode}`);
  await expect(page).toHaveURL(new RegExp(`/match/${created.matchId}$`));
  expect((await state()).players.map((p: { boardId: string }) => p.boardId)).toEqual(created.players.map(() => created.players[0].id));
});

test('deleting a waiting match sends its joined players home', async ({ page, request }) => {
  const response = await request.post('/api/v1/matches', { headers, data: { settings, players: [{ name: 'Alex' }, { name: 'Sam' }] } });
  const created = await response.json();
  await page.goto(`/lobby/join/${created.players[0].inviteCode}`);
  await expect(page.getByText('1/2 joined')).toBeVisible();

  const deleted = await request.delete(`/api/v1/matches/${created.matchId}`, { headers });
  expect(deleted.status()).toBe(200);
  expect(await deleted.json()).toMatchObject({ status: 'cancelled', resultExpiresAt: null });

  // The organizer called it off, so the browser holding a place in it goes home rather than sitting
  // on a lobby the server no longer has.
  await expect(page).toHaveURL(new RegExp(`${new URL(page.url()).origin}/?$`));
  expect((await request.get(`/api/v1/matches/${created.matchId}`, { headers })).status()).toBe(404);

  // The retired code cannot walk anyone back in.
  await page.goto(`/lobby/join/${created.players[1].inviteCode}`);
  await expect(page).toHaveURL(new RegExp(`${new URL(page.url()).origin}/?$`));
});
