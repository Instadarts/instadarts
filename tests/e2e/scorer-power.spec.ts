import { test, expect, type Browser, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { installFakeCamera, scan, showScene } from './fakeCamera';
import { skipOnboarding } from './appHelpers';

/**
 * A scoring device deciding for itself when to stop costing battery, and an owner reaching one from
 * the other room.
 *
 * The delays are driven down to seconds through the `?e2e=` seam — the real ones are minutes and
 * half-hours, and nothing about the rules changes with the numbers. Everything else here is real:
 * a real camera track that really stops, real sockets, and the server's real idea of whether a
 * match is running.
 *
 * **Each test here costs a model load.** `visionRuntime.start` compiles a 2.4MB model before it
 * touches the camera, so opening one is by far the most expensive thing in this file even though
 * none of it is about detection. That is why these are a few long tests rather than many short
 * ones: splitting them reads better and doubles the cost of the whole suite.
 */

const SCENES = {
  darts: fileURLToPath(new URL('../media/board-three-darts.jpg', import.meta.url)),
};

test.setTimeout(180_000);

/** Long enough for a round trip to a phone that is busy compiling a model in another tab. */
const ROUND_TRIP_MS = 30_000;

const GRACE_MS = 2_000;
const STANDBY_MS = 6_000;

async function openScorer(browser: Browser, { standbyMs = STANDBY_MS } = {}) {
  const context = await browser.newContext({ permissions: ['camera'] });
  await skipOnboarding(context);
  const page = await context.newPage();
  await installFakeCamera(page, SCENES);
  await page.goto(`/scorer?e2e=1&graceMs=${GRACE_MS}&standbyMs=${standbyMs}`);
  return { context, page };
}

async function pairCamera(player: Page, scorer: Page) {
  await player.getByRole('button', { name: 'Cameras' }).first().click();
  await player.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = (await player.locator('p.font-mono.tracking-\\[0\\.3em\\]').textContent())!.trim();

  await scorer.getByPlaceholder('CODE').fill(code);
  await scorer.getByRole('button', { name: 'Pair' }).click();
  await expect(scorer.getByPlaceholder('CODE')).toHaveCount(0);
}

async function startCamera(page: Page) {
  await page.getByRole('button', { name: /Start camera|Resume/ }).click();
  await expect(page.getByRole('button', { name: 'Stop scanning' })).toBeEnabled({ timeout: 90_000 });
}

/** Whether a camera is actually open, asked of the runtime rather than of the picture. */
async function cameraOn(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __scorer?: { camera: { active: boolean } } }).__scorer?.camera.active ?? false,
  );
}

async function disconnectScorer(page: Page) {
  await page.evaluate(() => {
    const link = (window as unknown as { __scorerLink?: { disconnect: () => void } }).__scorerLink;
    if (!link) throw new Error('scorer link not exposed — is ?e2e=1 set?');
    link.disconnect();
  });
}

async function reconnectScorer(page: Page) {
  await page.evaluate(() => {
    const link = (window as unknown as { __scorerLink?: { reconnect: () => void } }).__scorerLink;
    if (!link) throw new Error('scorer link not exposed — is ?e2e=1 set?');
    link.reconnect();
  });
}

async function pendingScorerMessages(page: Page): Promise<number> {
  return page.evaluate(() => {
    const link = (window as unknown as { __scorerLink?: { pendingMessages: () => number } }).__scorerLink;
    if (!link) throw new Error('scorer link not exposed — is ?e2e=1 set?');
    return link.pendingMessages();
  });
}

async function addPlayersAndStart(player: Page) {
  await player.fill('input[placeholder="New player name"]', 'Alice');
  await player.click('button:has-text("Add")');
  await player.click('button:has-text("Start Match")');
  await expect(player.locator('text=Submit Visit')).toBeVisible();
}

async function openLocalLobby(player: Page) {
  await player.goto('/');
  await player.click('button:has-text("Local Match")');
}

test.describe('a scoring device managing its own power', () => {
  test('stops an idle camera, unless somebody is touching the screen', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await openLocalLobby(player);

    const scorer = await openScorer(browser, { standbyMs: 600_000 });
    await pairCamera(player, scorer.page);
    await startCamera(scorer.page);
    expect(await cameraOn(scorer.page)).toBe(true);

    // Framing the board and calibrating the lens are both a finger on the screen every few seconds.
    // If the timer ignored that, setting a device up would be impossible.
    for (let i = 0; i < 6; i++) {
      await scorer.page.mouse.click(5, 5);
      await scorer.page.waitForTimeout(GRACE_MS / 2);
    }
    expect(await cameraOn(scorer.page)).toBe(true);
    await expect(scorer.page.getByTestId('powered-down')).toHaveCount(0);

    // Then left alone with no match to feed — the state that flattened a battery overnight.
    await expect(scorer.page.getByTestId('powered-down')).toBeVisible({ timeout: GRACE_MS + ROUND_TRIP_MS });
    expect(await cameraOn(scorer.page)).toBe(false);
    await expect(scorer.page.getByTestId('scorer-status')).toHaveText('Idle — camera off', { timeout: ROUND_TRIP_MS });

    // And the controls that need a camera say so. Stopping one used to publish the control state
    // *before* closing the track, so this button stayed live and green with nothing left to scan.
    const scanAutomatically = scorer.page.getByRole('button', { name: 'Scan automatically' });
    await expect(scanAutomatically).toBeDisabled();
    await expect(scorer.page.getByRole('button', { name: 'Scan now' })).toBeDisabled();

    // The owner is told, and by the device rather than by a guess.
    await expect(player.getByTestId('device-status')).toHaveText('connected', { timeout: ROUND_TRIP_MS });

    await frontend.close();
    await scorer.context.close();
  });

  test('an outage powers down, then a physical wake resumes its active match', async ({ browser }) => {
    // The push the server cannot get wrong: nothing else would ever restart this camera. And once a
    // match is running, scoring outranks the timer — a quiet leg is not an idle device.
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await openLocalLobby(player);

    const scorer = await openScorer(browser);
    await pairCamera(player, scorer.page);
    await startCamera(scorer.page);
    await expect(scorer.page.getByTestId('powered-down')).toBeVisible({ timeout: GRACE_MS + ROUND_TRIP_MS });

    await addPlayersAndStart(player);

    await expect(scorer.page.getByTestId('scorer-status'))
      .toHaveText('Scoring for a player', { timeout: ROUND_TRIP_MS });
    await expect.poll(() => cameraOn(scorer.page), { timeout: ROUND_TRIP_MS }).toBe(true);

    // A live match remains awake however quiet the board is.
    await scorer.page.waitForTimeout(GRACE_MS * 3);
    expect(await cameraOn(scorer.page)).toBe(true);
    await expect(scorer.page.getByTestId('scorer-status')).toHaveText('Scoring for a player');

    // Once the server is unreachable the retained state is no longer operational truth. The short
    // timer stops the camera and the long one releases the wake lock and closes the socket.
    await disconnectScorer(scorer.page);
    await expect(scorer.page.getByTestId('scorer-status')).toHaveText('Connecting…', { timeout: ROUND_TRIP_MS });
    await scan(scorer.page);
    expect(await pendingScorerMessages(scorer.page)).toBe(0);
    await expect(scorer.page.getByTestId('powered-down')).toBeVisible({ timeout: GRACE_MS + ROUND_TRIP_MS });
    expect(await cameraOn(scorer.page)).toBe(false);
    await expect(scorer.page.getByTestId('scorer-status'))
      .toHaveText('Asleep — tap to wake', { timeout: STANDBY_MS + ROUND_TRIP_MS });

    // Connectivity alone cannot wake a phone whose socket is intentionally closed. A physical tap
    // does; the server returns the same scoring context, and the camera resumes because the timer —
    // not its owner — was what stopped it.
    await scorer.page.mouse.click(5, 5);
    await expect(scorer.page.getByTestId('scorer-status'))
      .toHaveText('Scoring for a player', { timeout: ROUND_TRIP_MS });
    await expect.poll(() => cameraOn(scorer.page), { timeout: ROUND_TRIP_MS }).toBe(true);

    await frontend.close();
    await scorer.context.close();
  });

  test('keeps inferring outside a match, even though it stops sending tips', async ({ browser }) => {
    // Tips are dropped outside a match — the server discards them there anyway, so every one was a
    // frame's worth of bandwidth spent on nothing. But the inference behind them is what draws the
    // "N board points, M tips" line, which is the only feedback there is for aiming a camera, so
    // gating the publish must not gate the pipeline.
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await openLocalLobby(player);

    const scorer = await openScorer(browser, { standbyMs: 600_000 });
    await pairCamera(player, scorer.page);
    await startCamera(scorer.page);
    await showScene(scorer.page, 'darts');
    await scan(scorer.page);

    await expect(scorer.page.getByTestId('frame-info')).toContainText('3 tips', { timeout: ROUND_TRIP_MS });

    await frontend.close();
    await scorer.context.close();
  });

  test('goes to sleep and closes its socket once the long delay passes', async ({ browser }) => {
    // No camera in this one, and none needed: a device that was never started counts as one whose
    // camera is off, which is what the long timer waits on.
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await openLocalLobby(player);

    const scorer = await openScorer(browser);
    await pairCamera(player, scorer.page);

    await expect(scorer.page.getByTestId('scorer-status'))
      .toHaveText('Asleep — tap to wake', { timeout: STANDBY_MS + ROUND_TRIP_MS });

    // The socket is shut and stays shut — the reconnect backoff must not quietly undo this.
    await scorer.page.waitForTimeout(3_000);
    await expect(scorer.page.getByTestId('scorer-status')).toHaveText('Asleep — tap to wake');
    await expect(player.getByTestId('device-status')).toHaveText('offline', { timeout: ROUND_TRIP_MS });

    // And a tap brings it back, which is the only thing that can.
    await scorer.page.mouse.click(5, 5);
    await expect(player.getByTestId('device-status')).toHaveText('connected', { timeout: ROUND_TRIP_MS });

    await frontend.close();
    await scorer.context.close();
  });
});

test.describe('an owner reaching a device from the frontend', () => {
  test('turns the camera off and on, then powers the device off', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await openLocalLobby(player);

    const scorer = await openScorer(browser, { standbyMs: 600_000 });
    await pairCamera(player, scorer.page);
    // A match is running throughout, so nothing here is the idle timer doing the work.
    await addPlayersAndStart(player);
    // Starting the match meant clicking the page behind the device menu, which closes it. Back in.
    await player.getByRole('button', { name: 'Cameras' }).first().click();
    await startCamera(scorer.page);
    await expect(player.getByTestId('device-status')).toHaveText('camera on', { timeout: ROUND_TRIP_MS });

    // Off. Asserted on the device first, then on the row, so a failure says which half broke — a
    // phone that ignored the command, or a report that never came back.
    await player.getByRole('button', { name: 'Camera off' }).click();
    await expect.poll(() => cameraOn(scorer.page), { timeout: ROUND_TRIP_MS }).toBe(false);
    await expect(player.getByTestId('device-status')).toHaveText('connected', { timeout: ROUND_TRIP_MS });

    // Off mid-match sticks: a match is still running, and nothing turns it back on but a person.
    await scorer.page.waitForTimeout(GRACE_MS * 2);
    expect(await cameraOn(scorer.page)).toBe(false);

    // It also sticks through a replacement socket. The first fresh state names the same scoring
    // context, so this is a resume rather than a match beginning.
    await disconnectScorer(scorer.page);
    await expect(player.getByTestId('device-status')).toHaveText('offline', { timeout: ROUND_TRIP_MS });
    await reconnectScorer(scorer.page);
    await expect(scorer.page.getByTestId('scorer-status'))
      .toHaveText('Scoring for a player', { timeout: ROUND_TRIP_MS });
    expect(await cameraOn(scorer.page)).toBe(false);

    // And on again. Given an explicit wait rather than the whole test budget: the button appears in
    // a second or it is not going to, and burning three minutes to find that out helps nobody.
    await player.getByRole('button', { name: 'Camera on' }).click({ timeout: ROUND_TRIP_MS });
    await expect.poll(() => cameraOn(scorer.page), { timeout: ROUND_TRIP_MS }).toBe(true);
    await expect(player.getByTestId('device-status')).toHaveText('camera on', { timeout: ROUND_TRIP_MS });

    // Power off is the one-way one.
    await player.getByRole('button', { name: 'Power off' }).click();
    await player.getByRole('button', { name: 'Power off' }).click(); // the confirmation

    await expect(scorer.page.getByTestId('scorer-status'))
      .toHaveText('Asleep — tap to wake', { timeout: ROUND_TRIP_MS });
    expect(await cameraOn(scorer.page)).toBe(false);

    // A phone that was asked to sleep and one whose battery died leave the same closed socket; only
    // this side knows which happened.
    await expect(player.getByTestId('device-status')).toHaveText('powered off', { timeout: ROUND_TRIP_MS });

    await frontend.close();
    await scorer.context.close();
  });
});
