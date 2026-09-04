import { test, expect, type Page, type Browser, type Locator } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { installFakeCamera, scan, showScene, type FakeCameraOptions } from './fakeCamera';
import { cameraPreviewPresentation, closeScorerSettings, pairingCode, setSwitch, skipOnboarding, startScorerCamera } from './appHelpers';

// The two reference photographs: the same board, with three darts in the 20 bed and then empty.
const SCENES = {
  darts: fileURLToPath(new URL('../media/board-three-darts.jpg', import.meta.url)),
  empty: fileURLToPath(new URL('../media/board-empty.jpg', import.meta.url)),
};

/** Loading a 2.4MB model and running it is slower than clicking a button. */
test.setTimeout(120_000);

async function openScorer(browser: Browser, cameraOptions: FakeCameraOptions = {}) {
  const context = await browser.newContext({ permissions: ['camera'] });
  await skipOnboarding(context);
  const page = await context.newPage();
  await installFakeCamera(page, SCENES, cameraOptions);
  await page.goto('/scorer?e2e=1');
  return { context, page };
}

async function expectCenteredSquarePreview(video: Locator) {
  const presentation = await cameraPreviewPresentation(video);
  expect(Math.abs(presentation.viewportWidth - presentation.viewportHeight), 'preview viewport is square')
    .toBeLessThan(2);
  expect(Math.abs(presentation.videoWidth - presentation.viewportInnerWidth), 'video fills the viewport width')
    .toBeLessThan(2);
  expect(Math.abs(presentation.videoHeight - presentation.viewportInnerHeight), 'video fills the viewport height')
    .toBeLessThan(2);
  expect(presentation).toMatchObject({
    objectFit: 'cover',
    objectPosition: '50% 50%',
    position: 'absolute',
  });
  return presentation;
}

async function startLocalMatch(page: Page) {
  await page.goto('/');
  await page.click('button:has-text("Local Match")');
  await page.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
  await page.click('button:has-text("Add")');
  await page.click('button:has-text("Start Match")');
  await expect(page.locator('text=Submit Visit')).toBeVisible();
}

async function pairCamera(player: Page, scorer: Page, scoring = true) {
  await player.getByRole('button', { name: 'Cameras' }).first().click();
  await player.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = (await pairingCode(player).textContent())!.trim();

  await scorer.getByPlaceholder('CODE').fill(code);
  await scorer.getByRole('button', { name: 'Pair' }).click();
  // Two server round trips, not one: the device is bound, then the frontend claims it, and only
  // then does the device learn a match is running. Worth an explicit wait on the first test of a
  // run, where that competes with a 2.4MB model being fetched and compiled.
  if (scoring) {
    await expect(scorer.getByTestId('scorer-status')).toHaveText('Scoring for a player', { timeout: 20_000 });
  } else {
    await expect(scorer.getByPlaceholder('CODE')).toHaveCount(0);
  }
}

test.describe('camera scoring, end to end', () => {
  test('keeps the centered scoring preview mounted while calibration and model resolution change', async ({ browser }) => {
    test.setTimeout(180_000);
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser, { maxWidth: 1280, maxHeight: 720 });

    await player.goto('/');
    await pairCamera(player, scorer.page, false);
    await startScorerCamera(scorer.page);

    const preview = scorer.page.locator('#preview');
    await expect(preview).toBeVisible();
    const initial = await expectCenteredSquarePreview(preview);
    expect({ width: initial.sourceWidth, height: initial.sourceHeight })
      .toEqual({ width: 960, height: 720 });
    await expect(scorer.page.getByText('960×720', { exact: true })).toBeVisible();

    await preview.evaluate((video) => { video.dataset.e2eIdentity = 'original-preview'; });
    const initialViewport = { width: initial.viewportWidth, height: initial.viewportHeight };

    await scorer.page.getByRole('button', { name: 'Settings' }).click();
    await scorer.page.getByRole('button', { name: 'Calibrate lens' }).click();
    await expect(scorer.page.getByText('Slide until the lines sit on the wires', { exact: false }))
      .toBeVisible({ timeout: 30_000 });
    await expect(preview).toHaveAttribute('data-e2e-identity', 'original-preview');
    await scorer.page.getByRole('button', { name: 'Done' }).click();
    await expect(preview).toBeVisible();

    await scorer.page.getByRole('button', { name: 'Settings' }).click();
    await scorer.page.getByRole('combobox', { name: 'Detection model' }).selectOption('s_1280');
    await expect.poll(async () => {
      const presentation = await cameraPreviewPresentation(preview);
      return { width: presentation.sourceWidth, height: presentation.sourceHeight };
    }, { timeout: 120_000 }).toEqual({ width: 1280, height: 720 });
    await closeScorerSettings(scorer.page);

    await expect(preview).toHaveAttribute('data-e2e-identity', 'original-preview');
    await expect(scorer.page.getByText('1280×720', { exact: true })).toBeVisible();
    const restarted = await expectCenteredSquarePreview(preview);
    expect(Math.abs(restarted.viewportWidth - initialViewport.width)).toBeLessThan(2);
    expect(Math.abs(restarted.viewportHeight - initialViewport.height)).toBeLessThan(2);

    await frontend.close();
    await scorer.context.close();
  });

  test('can force each vision stage onto its CPU path independently', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser);

    await player.goto('/');
    await player.click('button:has-text("Local Match")');
    await pairCamera(player, scorer.page, false);

    await scorer.page.getByRole('button', { name: 'Settings' }).click();
    await setSwitch(scorer.page.getByRole('switch', { name: /^Motion detector\b/ }), true);
    await setSwitch(scorer.page.getByRole('switch', { name: /^Preprocessing\b/ }), true);
    await setSwitch(scorer.page.getByRole('switch', { name: /^Inference\b/ }), true);
    await closeScorerSettings(scorer.page);

    await startScorerCamera(scorer.page);
    await showScene(scorer.page, 'darts');
    await scan(scorer.page);
    await expect(scorer.page.getByTestId('frame-info')).toContainText('[cpu/wasm]');

    // Re-arm after startCamera's deterministic-test disarm. The analyzer badge is its live report,
    // so this verifies the toggle reaches the motion gate rather than only persisting in the UI.
    await scorer.page.getByRole('button', { name: 'Scan automatically' }).click();
    await expect(scorer.page.getByText(/cpu-detector:/)).toBeVisible({ timeout: 10_000 });

    await frontend.close();
    await scorer.context.close();
  });

  test('starting the camera primes inference and puts visible darts in the visit', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser);

    // Cross-origin isolation is the one misconfiguration that degrades silently rather than
    // failing, so it is asserted rather than assumed.
    expect(await scorer.page.evaluate(() => crossOriginIsolated)).toBe(true);

    await startLocalMatch(player);
    await pairCamera(player, scorer.page);
    await startScorerCamera(scorer.page);

    // The fake camera opens on the three-dart photograph. Nothing below asks for an inference: a
    // successful camera start includes exactly one forced cold pass after model, frame, motion gate,
    // zoom and per-camera lens calibration are ready.
    await expect(scorer.page.getByTestId('frame-info')).toContainText('8 board points');
    await expect(scorer.page.getByTestId('frame-info')).toContainText('3 tips');
    expect(await scorer.page.evaluate(() =>
      (window as unknown as { __scorer: { located: boolean } }).__scorer.located)).toBe(true);

    // The darts reach the player's visit, scored by the server after fusion.
    await expect(player.getByText('Visit: 140')).toBeVisible({ timeout: 15_000 });
    await expect(player.getByText('T20', { exact: true })).toHaveCount(2);
    await expect(player.getByText('S20', { exact: true })).toHaveCount(1);

    // A full visit does NOT submit: the player is still standing there, and that gap is where a
    // misread third dart gets fixed.
    await scan(scorer.page);
    await expect(player.getByText('Visit: 140')).toBeVisible();
    await expect(player.locator('[data-player="Alice"]').getByText('361', { exact: true })).toBeVisible();

    // --- the darts come out ---
    await showScene(scorer.page, 'empty');
    await scan(scorer.page);

    // An empty board that every camera agrees on ends the visit: 501 - 140 = 361.
    await expect(player.getByText('Visit: 0')).toBeVisible({ timeout: 15_000 });
    await expect(player.locator('[data-player="Alice"]').getByText('361', { exact: true })).toBeVisible();

    await frontend.close();
    await scorer.context.close();
  });

  test('a manual submit hands the next player a clean board', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser);

    await player.goto('/');
    await player.click('button:has-text("Local Match")');
    await player.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await player.click('button:has-text("Add")');
    await player.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
    await player.click('button:has-text("Add")');
    await player.click('button:has-text("Start Match")');
    await expect(player.locator('text=Submit Visit')).toBeVisible();

    await pairCamera(player, scorer.page);
    await startScorerCamera(scorer.page);
    await showScene(scorer.page, 'darts');
    await scan(scorer.page);
    await expect(player.getByText('Visit: 140')).toBeVisible({ timeout: 15_000 });

    // Alice sends the visit herself rather than waiting for the takeout. The committed score and
    // turn change arrive in the server's reply; the client commits nothing on its own.
    await player.click('button:has-text("Submit Visit")');
    await expect(player.locator('[data-player="Alice"]').getByText('361', { exact: true }))
      .toBeVisible({ timeout: 15_000 });
    await expect(player.locator('[data-player="Bob"]')).toHaveAttribute('aria-current', 'true');
    await expect(player.locator('[data-player="Bob"]').getByText('501', { exact: true })).toBeVisible();

    // Tracking is per-visit: Bob's throw into the very same treble is his own, not a re-sighting
    // of Alice's darts.
    await scan(scorer.page);
    await expect(player.getByText('Visit: 140')).toBeVisible({ timeout: 15_000 });
    // Alice's visit remains committed while Bob has a second visit in flight.
    await expect(player.locator('[data-player="Alice"]').getByText('361', { exact: true })).toBeVisible();
    await expect(player.locator('[data-player="Bob"]').getByText('361', { exact: true })).toBeVisible();

    await frontend.close();
    await scorer.context.close();
  });

  test('the lens calibration draws the board over a frozen frame', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    const scorer = await openScorer(browser);

    await startLocalMatch(player);
    await pairCamera(player, scorer.page);
    await startScorerCamera(scorer.page);
    await showScene(scorer.page, 'darts');

    await scorer.page.getByRole('button', { name: 'Settings' }).click();
    await expect(scorer.page.getByRole('combobox', { name: 'Model' })).toHaveValue('s_960');
    // The fake camera exposes no zoom capability, and the panel says so rather than showing a
    // control that would do nothing.
    await expect(scorer.page.getByText('This camera does not expose a zoom control.')).toBeVisible();

    await scorer.page.getByRole('button', { name: 'Calibrate lens' }).click();
    await expect(scorer.page.getByText('Slide until the lines sit on the wires')).toBeVisible({ timeout: 30_000 });

    // Eight keypoints and a solved projection: rings, sector boundaries and the detections.
    const svg = scorer.page.locator('svg[viewBox="0 0 1 1"]');
    await expect(svg.locator('circle')).toHaveCount(11); // 8 board keypoints + 3 dart tips
    expect(await svg.locator('path').count()).toBeGreaterThan(10);

    // The slider moves the drawn board, which is the whole point of it.
    const before = await svg.locator('path').first().getAttribute('d');
    await scorer.page.getByRole('slider', { name: 'Lens correction' }).press('End');
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

    // Put the empty board in the camera before arming it. `showScene` guarantees presentation, but
    // the motion loop has its own clock; switching empty -> darts after the camera starts can outrun
    // its first sample and compare darts with darts. Starting on empty gives the detector the same
    // stable baseline a mounted real camera has before a throw.
    await showScene(scorer.page, 'empty');

    // Deliberately NOT disarmed: this is the path a real throw takes. Starting the camera arms the
    // detector, so nothing below asks for an inference — the darts appearing is the assertion.
    await startScorerCamera(scorer.page, { disarmMotion: false });
    await expect.poll(() => scorer.page.evaluate(() =>
      (window as unknown as { __scorer: { motion: { completedAnalyses: number } } })
        .__scorer.motion.completedAnalyses)).toBeGreaterThan(0);

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
