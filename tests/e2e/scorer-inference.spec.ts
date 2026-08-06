import { test, expect, type Page, type Browser } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { installVirtualCamera, scan, showScene } from './virtualCamera';

// The two reference photographs: the same board, with three darts in the 20 bed and then empty.
const SCENES = {
  darts: fileURLToPath(new URL('../media/board-three-darts.jpg', import.meta.url)),
  empty: fileURLToPath(new URL('../media/board-empty.jpg', import.meta.url)),
};

/** Loading a 2.4MB model and running it is slower than clicking a button. */
test.setTimeout(120_000);

/**
 * What the model finds in the three-dart photo: two darts in the treble 20 and one in the single,
 * totalling 140.
 */
const EXPECTED_DARTS = ['S20', 'T20', 'T20'];

function sortedLabels(text: string | null): string[] {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).sort();
}

/** Every committed visit in the player's history, as `{darts, total}`. */
async function visitHistory(player: Page): Promise<{ darts: string[]; total: string }[]> {
  const lines = await player.locator('div:has(> h3:text("Visit History")) span.font-mono').allTextContents();
  return lines.map((line) => {
    const [darts, total] = line.split(' = ');
    return { darts: sortedLabels(darts), total: total.trim() };
  });
}

async function openScorer(browser: Browser) {
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await context.newPage();
  await installVirtualCamera(page, SCENES);
  await page.goto('/scorer?e2e=1');
  return { context, page };
}

async function startLocalMatch(page: Page) {
  await page.goto('/');
  await page.click('button:has-text("Local Match")');
  await page.fill('input[placeholder="New player name"]', 'Alice');
  await page.click('button:has-text("Add")');
  await page.click('button:has-text("Start Match")');
  await expect(page.locator('text=Submit Visit')).toBeVisible();
}

async function pairCamera(player: Page, scorer: Page) {
  await player.getByRole('button', { name: 'Cameras' }).first().click();
  await player.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = (await player.locator('p.font-mono.tracking-\\[0\\.3em\\]').textContent())!.trim();

  await scorer.getByPlaceholder('CODE').fill(code);
  await scorer.getByRole('button', { name: 'Pair' }).click();
  await expect(scorer.getByText('Scoring for a player')).toBeVisible();
}

async function startCamera(page: Page) {
  await page.getByRole('button', { name: 'Start camera' }).click();
  // The model is fetched and compiled on the first start; give it room.
  await expect(page.getByRole('button', { name: 'Stop watching' })).toBeEnabled({ timeout: 90_000 });
  // Motion stays disarmed: frame differencing over a captured canvas is not deterministic, and the
  // gate is not what this test is about. Inference is triggered explicitly instead.
  await page.evaluate(() => (window as unknown as { __scorer: { motion: { disarm: () => void } } }).__scorer.motion.disarm());
}

test.describe('camera scoring, end to end', () => {
  test('a real inference on a real board photo puts real darts in the visit', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser);

    // Cross-origin isolation is the one misconfiguration that degrades silently rather than
    // failing, so it is asserted rather than assumed.
    expect(await scorer.page.evaluate(() => crossOriginIsolated)).toBe(true);

    await startLocalMatch(player);
    await pairCamera(player, scorer.page);
    await startCamera(scorer.page);

    // --- three darts in the 20 bed ---
    await showScene(scorer.page, 'darts');
    await scan(scorer.page);

    await expect(scorer.page.getByTestId('frame-info')).toContainText('8 board points');
    await expect(scorer.page.getByTestId('frame-info')).toContainText('3 tips');

    // The darts reach the player's visit, scored by the server after fusion.
    await expect(player.getByText('Visit: 140')).toBeVisible({ timeout: 15_000 });
    await expect(player.getByText('T20 (60)')).toHaveCount(2);
    await expect(player.getByText('S20 (20)')).toHaveCount(1);

    // A full visit does NOT submit: the player is still standing there, and that gap is where a
    // misread third dart gets fixed.
    await scan(scorer.page);
    await expect(player.getByText('Visit: 140')).toBeVisible();
    expect(await visitHistory(player)).toEqual([]);

    // --- the darts come out ---
    await showScene(scorer.page, 'empty');
    await scan(scorer.page);

    // An empty board that every camera agrees on ends the visit: 501 - 140 = 361.
    await expect(player.getByText('Visit: 0')).toBeVisible({ timeout: 15_000 });
    expect(await visitHistory(player)).toEqual([{ darts: EXPECTED_DARTS, total: '140' }]);
    await expect(player.getByText('361', { exact: true })).toBeVisible();

    await frontend.close();
    await scorer.context.close();
  });

  test('a manual submit hands the next player a clean board', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser);

    await player.goto('/');
    await player.click('button:has-text("Local Match")');
    await player.fill('input[placeholder="New player name"]', 'Alice');
    await player.click('button:has-text("Add")');
    await player.fill('input[placeholder="New player name"]', 'Bob');
    await player.click('button:has-text("Add")');
    await player.click('button:has-text("Start Match")');
    await expect(player.locator('text=Submit Visit')).toBeVisible();

    await pairCamera(player, scorer.page);
    await startCamera(scorer.page);
    await showScene(scorer.page, 'darts');
    await scan(scorer.page);
    await expect(player.getByText('Visit: 140')).toBeVisible({ timeout: 15_000 });

    // Alice sends the visit herself rather than waiting for the takeout.
    await player.click('button:has-text("Submit Visit")');
    expect(await visitHistory(player)).toEqual([{ darts: EXPECTED_DARTS, total: '140' }]);

    // Tracking is per-visit: Bob's throw into the very same treble is his own, not a re-sighting
    // of Alice's darts.
    await scan(scorer.page);
    await expect(player.getByText('Visit: 140')).toBeVisible({ timeout: 15_000 });
    // Still one committed visit, with a second now in flight — so both players read 361.
    expect(await visitHistory(player)).toHaveLength(1);
    await expect(player.getByText('361', { exact: true })).toHaveCount(2);

    await frontend.close();
    await scorer.context.close();
  });

  test('the lens calibration draws the board over a frozen frame', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser);

    await startLocalMatch(player);
    await pairCamera(player, scorer.page);
    await startCamera(scorer.page);
    await showScene(scorer.page, 'darts');

    await scorer.page.getByRole('button', { name: 'Settings' }).click();
    await expect(scorer.page.getByRole('combobox')).toHaveValue('s_960');
    // The virtual camera exposes no zoom capability, and the panel says so rather than showing a
    // control that would do nothing.
    await expect(scorer.page.getByText('This camera does not expose a zoom control.')).toBeVisible();

    await scorer.page.getByRole('button', { name: 'Calibrate lens' }).click();
    await expect(scorer.page.getByText('Slide until the lines sit on the wires')).toBeVisible({ timeout: 30_000 });

    // Eight keypoints and a solved projection: rings, sector boundaries and the detections.
    const svg = scorer.page.locator('svg').filter({ has: scorer.page.locator('circle') });
    await expect(svg.locator('circle')).toHaveCount(11); // 8 board keypoints + 3 dart tips
    expect(await svg.locator('path').count()).toBeGreaterThan(10);

    // The slider moves the drawn board, which is the whole point of it.
    const before = await svg.locator('path').first().getAttribute('d');
    await scorer.page.locator('input[type="range"]').fill('60');
    await expect(svg.locator('path').first()).not.toHaveAttribute('d', before!);

    await frontend.close();
    await scorer.context.close();
  });

  test('the motion gate fires an inference on its own when the board changes', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser);

    await startLocalMatch(player);
    await pairCamera(player, scorer.page);

    // Deliberately NOT disarmed: this is the path a real throw takes. Starting the camera arms the
    // detector, so nothing below asks for an inference — the darts appearing is the assertion.
    await scorer.page.getByRole('button', { name: 'Start camera' }).click();
    await expect(scorer.page.getByRole('button', { name: 'Stop watching' })).toBeEnabled({ timeout: 90_000 });

    await showScene(scorer.page, 'empty');
    await showScene(scorer.page, 'darts');

    await expect(player.getByText('Visit: 140')).toBeVisible({ timeout: 30_000 });

    await frontend.close();
    await scorer.context.close();
  });

  test('an unpaired scoring device changes nothing', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await startLocalMatch(player);

    // A device that never redeemed a code cannot even open its camera panel, so drive the wire
    // directly: this is the shape a bad actor would actually send.
    const intruder = await browser.newContext();
    const page = await intruder.newPage();
    await page.goto('/scorer');
    await page.evaluate(async () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      await new Promise((resolve) => ws.addEventListener('open', resolve));
      ws.send(JSON.stringify({
        type: 'scorer_tips',
        tips: [{ x: 500000, y: 726000, confidence: 0.99 }],
      }));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    await expect(player.getByText('Visit: 0')).toBeVisible();
    await expect(player.getByText('501', { exact: true })).toBeVisible();

    await frontend.close();
    await intruder.close();
  });
});
