import { test, expect, type Browser, type Page } from '@playwright/test';
import { skipOnboarding } from './appHelpers';

/**
 * Waking a blacked-out phone, without also pressing what the black was covering.
 *
 * The whole point of the screensaver is that a device can sit mounted all evening; the whole point
 * of *this* is that reaching out to it costs nothing. A wake tap that lands on the settings button —
 * or, on a match screen, on the board — is worse than no screensaver at all.
 *
 * No camera is started anywhere here, so nothing in this file loads the model.
 */

const IDLE_MS = 800;

async function openScorer(browser: Browser) {
  // A real touchscreen, because that is where the problem lives: a touch that ends over an element
  // leaves a synthesised click behind, and a mouse does not.
  const context = await browser.newContext({ hasTouch: true });
  await skipOnboarding(context);
  const page = await context.newPage();
  await page.goto(`/scorer?e2e=1&screensaverMs=${IDLE_MS}`);
  return { context, page };
}

async function pair(player: Page, scorer: Page) {
  await player.goto('/');
  await player.getByRole('button', { name: 'Cameras' }).first().click();
  await player.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = (await player.locator('p.font-mono.tracking-\\[0\\.3em\\]').textContent())!.trim();

  await scorer.getByPlaceholder('CODE').fill(code);
  await scorer.getByRole('button', { name: 'Pair' }).click();
  await expect(scorer.getByPlaceholder('CODE')).toHaveCount(0);
}

/** Wait out the idle period without touching anything. */
async function fallAsleep(scorer: Page) {
  await expect(scorer.getByTestId('screensaver')).toBeVisible({ timeout: IDLE_MS + 10_000 });
}

async function centreOf(page: Page, name: string) {
  const box = (await page.getByRole('button', { name }).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const backgroundOf = (page: Page) =>
  page.getByTestId('screensaver').evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe('waking the screensaver', () => {
  test('goes clear while the finger is down and only lifts when it comes up', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser);
    await pair(player, scorer.page);
    await fallAsleep(scorer.page);

    expect(await backgroundOf(scorer.page)).toBe('rgb(0, 0, 0)');

    const settings = await centreOf(scorer.page, 'Settings');
    await scorer.page.mouse.move(settings.x, settings.y);
    await scorer.page.mouse.down();

    // The screen responds at once — but the overlay is still there, between the press and the
    // button. Removing it here, which is what used to happen, is what let taps through.
    await expect.poll(() => backgroundOf(scorer.page)).toBe('rgba(0, 0, 0, 0)');
    await expect(scorer.page.getByTestId('screensaver')).toBeVisible();

    await scorer.page.mouse.up();
    await expect(scorer.page.getByTestId('screensaver')).toHaveCount(0);

    await frontend.close();
    await scorer.context.close();
  });

  test('a tap that wakes the screen does not press what it was covering', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser);
    await pair(player, scorer.page);

    // Aimed squarely at Settings, which is unmissable when it opens.
    const settings = await centreOf(scorer.page, 'Settings');
    await fallAsleep(scorer.page);

    await scorer.page.touchscreen.tap(settings.x, settings.y);

    await expect(scorer.page.getByTestId('screensaver')).toHaveCount(0);
    // Nothing opened: the tap woke the screen and stopped there. Waiting out the click a touch
    // leaves behind, which arrives a moment after the finger lifts.
    await scorer.page.waitForTimeout(1_000);
    await expect(scorer.page.getByRole('button', { name: 'Calibrate lens' })).toHaveCount(0);
    await expect(scorer.page.getByRole('button', { name: 'Settings' })).toBeVisible();

    // And the button still works, so nothing has been left swallowing taps.
    await scorer.page.touchscreen.tap(settings.x, settings.y);
    await expect(scorer.page.getByRole('button', { name: 'Calibrate lens' })).toBeVisible();

    await frontend.close();
    await scorer.context.close();
  });

  test('a key press wakes it outright, having nothing to swallow', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser);
    await pair(player, scorer.page);
    await fallAsleep(scorer.page);

    await scorer.page.keyboard.press('Escape');

    await expect(scorer.page.getByTestId('screensaver')).toHaveCount(0);

    await frontend.close();
    await scorer.context.close();
  });
});
