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
