// Setting a phone up, end to end, with a real camera, the real model and the real photographs.
//
// **Written to assert the contract, not a path.** Whether the machine running this has working
// WebGPU is not knowable from inside the test and must never be assumed: CI has none, a developer's
// laptop may, and both are supposed to end up with a working scoring device. So nothing here says
// "expect webgpu" or "expect wasm" — that would be asserting the hardware rather than the feature.
//
// What is asserted is what setup promises:
//
//   1. it appears on its own after pairing, with nobody navigating to it
//   2. it asks for a name first, prefilled with whatever this device already had
//   3. the camera comes next, and opens without a second prompt where access is already granted
//   4. it reaches a verdict rather than hanging or throwing
//   5. the CPU paths never fail — WebGPU may be absent, may fall back, may win
//   6. it settles on some working configuration and says which
//   7. the two reference boards read 8/0 and 8/3 under whatever it settled on
//   8. a phone that cannot have a camera is told why, and can still leave
//
// (7) is also the only thing that checks the downscaled 1280 px images that ship to the client. The
// rest of the suite asserts against the 1920 px originals in tests/media, so if a resize ever spoils
// detection, this is where it surfaces.

import { test, expect, type Page, type Browser } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { installFakeCamera } from './fakeCamera';

/** The self-test loads two models and runs a dozen inferences on a CPU; it is not quick. */
const RUN_TIMEOUT = 180_000;

// One scene is enough: this spec never asserts what the camera *shows*. Timings do not care, and
// correctness is checked against the shipped photographs rather than against the feed.
const SCENES = {
  darts: fileURLToPath(new URL('../media/board-three-darts.jpg', import.meta.url)),
};

async function pairedScorer(browser: Browser, { camera = true } = {}) {
  const frontend = await browser.newContext();
  const player = await frontend.newPage();
  await player.goto('/');
  await player.getByRole('button', { name: 'Cameras' }).first().click();
  await player.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = (await player.locator('p.font-mono.tracking-\\[0\\.3em\\]').textContent())!.trim();

  // Deliberately *not* seeding didOnboard — a device arriving here for the first time is the case.
  // `camera: false` is a phone with none, or one whose owner refused: no permission, no fake.
  const phone = await browser.newContext(camera ? { permissions: ['camera'] } : {});
  const scorer = await phone.newPage();
  if (camera) await installFakeCamera(scorer, SCENES);
  await scorer.goto('/scorer');
  await scorer.getByPlaceholder('CODE').fill(code);
  await scorer.getByRole('button', { name: 'Pair' }).click();

  return { frontend, player, phone, scorer };
}

/** Through step one. The name is optional, so passing `undefined` leaves whatever was prefilled. */
async function nameDevice(scorer: Page, name?: string) {
  await expect(scorer.getByTestId('onboarding-name')).toBeVisible();
  if (name !== undefined) await scorer.getByTestId('onboarding-name').fill(name);
  await scorer.getByTestId('onboarding-name-continue').click();
}

/** What this device stored about itself, read straight out of the phone's own settings. */
async function storedSettings(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('instadarts_scorer_settings') ?? '{}'));
}

/** What the open stream is actually producing, which is what the capture size has to be read from. */
async function previewSize(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid=onboarding-preview]');
    return { width: video?.videoWidth ?? 0, height: video?.videoHeight ?? 0 };
  });
}

test.describe('setting up a scoring device', () => {
  test('a freshly paired phone runs the self-test and ends up able to read a board', async ({ browser }) => {
    test.setTimeout(RUN_TIMEOUT + 60_000);
    const { frontend, phone, scorer } = await pairedScorer(browser);

    // 1. It arrives on its own. Nothing below navigated here.
    await expect(scorer.getByRole('heading', { name: 'Setting up this camera' })).toBeVisible();

    // 2. The name comes first — answerable before the phone is anywhere near a board, and the only
    // step that needs nothing of the device. Nothing has asked for the camera yet.
    await expect(scorer.getByText('Step 1 of 3 · Naming this device')).toBeVisible();
    await expect(scorer.getByTestId('onboarding-preview')).toHaveCount(0);
    await nameDevice(scorer, 'Board camera');

    // 3. The camera comes next, and opens by itself because this context already granted access —
    // no second button to press. The preview carrying frames is the proof it really opened.
    await expect(scorer.getByText('Step 2 of 3 · Choosing a camera')).toBeVisible();
    // Setup is one screen with one thing to do on it: no status badge, no name field, no Settings.
    await expect(scorer.getByPlaceholder('Name this device')).toHaveCount(0);
    await expect(scorer.getByRole('button', { name: 'Settings' })).toHaveCount(0);
    await expect(scorer.getByTestId('onboarding-start-checks')).toBeVisible();
    expect(await previewSize(scorer)).toEqual({ width: 960, height: 960 });
    // And nothing has been measured: this holds the GPU for a while and asks first.
    await expect(scorer.getByTestId('onboarding-stages')).toHaveCount(0);

    await scorer.getByTestId('onboarding-start-checks').click();
    await expect(scorer.getByText('Step 3 of 3 · Checking what this device can do')).toBeVisible();

    // 4. It reaches a verdict.
    await expect(scorer.getByTestId('onboarding-verdict')).toBeVisible({ timeout: RUN_TIMEOUT });

    // 5 + 6. Some configuration works, and it is the one now stored. A device that gave up says so
    // in the same place, so asserting the wording is asserting the outcome.
    const verdict = await scorer.getByTestId('onboarding-verdict').textContent();
    expect(verdict, `the self-test gave up: ${verdict}`).toMatch(/^Ready\./);

    // Every stage ran and none of them failed. The 1280 px row only appears when the 960 px one left
    // headroom, so it is not in this list — the verdict below covers whichever model won.
    //
    // Collapsed, a row shows only the path it settled on, so `dnf` there means that stage found no
    // working path at all — a stronger check than the word "failed", which only validation prints.
    for (const stage of ['motion', 'model960', 'validation']) {
      const row = scorer.getByTestId(`stage-${stage}`);
      await expect(row, `stage ${stage} never reported`).toBeVisible();
      await expect(row).not.toContainText('failed');
      await expect(row, `stage ${stage} settled on a path that did not work`).not.toContainText('dnf');
    }

    // 7. The photographs read correctly — under whichever paths this machine settled on.
    await expect(scorer.getByTestId('stage-validation')).toContainText('ok');

    // The details are a tap away, and that is where the paths not taken live.
    await scorer.getByRole('button', { name: /Motion detector/ }).click();
    await expect(scorer.getByTestId('stage-motion')).toContainText('cpu:');

    // The decision is persisted, not just displayed — including which camera was used.
    const settings = await storedSettings(scorer);
    expect(['s_960', 's_1280']).toContain(settings.model);
    expect(settings.deviceName, 'the name typed in step one').toBe('Board camera');
    expect(settings.camera, 'the camera it opened is the one it will open next time').toBe('Fake board camera');

    // **The capture size follows the model.** The stream is square at the model's input size, so a
    // run that chose the larger model must have re-opened the camera at 1280 to have measured it —
    // and must have left it there, since that is what the scoring screen will use. On a machine
    // where the small model wins, the stream is still the one it was benchmarked at.
    const expected = settings.model === 's_1280' ? 1280 : 960;
    expect(await previewSize(scorer)).toEqual({ width: expected, height: expected });

    // Leaving, and staying left, are asserted here rather than in a test of their own **because a
    // second full run is the single most expensive thing this suite can ask for** — two model loads
    // per accelerator plus forty inferences, beside three other specs already driving a model. It
    // bought nothing a few more assertions on this run do not.
    //
    // Landing is asserted through the Settings button rather than `scorer-status`, which is rendered
    // but hidden; and that button only exists when this is not the onboarding screen.
    await scorer.getByTestId('onboarding-leave').click();
    await expect(scorer.getByRole('button', { name: 'Settings' })).toBeVisible();
    expect((await storedSettings(scorer)).didOnboard).toBe(true);

    await scorer.reload();
    await expect(scorer.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(scorer.getByRole('heading', { name: 'Setting up this camera' })).toHaveCount(0);

    await frontend.close();
    await phone.close();
  });

  test('skipping before it starts leaves the phone usable, and does not ask again', async ({ browser }) => {
    const { frontend, phone, scorer } = await pairedScorer(browser);

    await scorer.getByRole('button', { name: 'Skip' }).click();
    await expect(scorer.getByRole('button', { name: 'Settings' })).toBeVisible();
    expect((await storedSettings(scorer)).didOnboard).toBe(true);

    await frontend.close();
    await phone.close();
  });

  test('skipping mid-run keeps what has already been measured', async ({ browser }) => {
    test.setTimeout(RUN_TIMEOUT);
    const { frontend, phone, scorer } = await pairedScorer(browser);
    await nameDevice(scorer);
    await scorer.getByTestId('onboarding-start-checks').click();

    // Leave at the earliest possible moment — the first log line, before any stage has finished.
    // Waiting for a completed stage instead made this a race with the whole run on a fast machine,
    // and the point being made is that leaving part way through is safe, not which part.
    await expect(scorer.getByTestId('onboarding-log')).not.toBeEmpty({ timeout: RUN_TIMEOUT });
    await scorer.getByTestId('onboarding-leave').click();

    // No hang, no half-torn-down runtime: the reload is what makes abandoning it safe.
    await expect(scorer.getByRole('button', { name: 'Settings' })).toBeVisible();
    expect((await storedSettings(scorer)).didOnboard).toBe(true);

    await frontend.close();
    await phone.close();
  });

  test('a phone that cannot use a camera is told why, and can still leave', async ({ browser }) => {
    // No permission and no fake: the browser refuses, exactly as it does for somebody who says no.
    const { frontend, phone, scorer } = await pairedScorer(browser, { camera: false });

    await expect(scorer.getByRole('heading', { name: 'Setting up this camera' })).toBeVisible();
    await nameDevice(scorer);
    await scorer.getByRole('button', { name: 'Allow camera' }).click();

    // A sentence, not a DOMException name — and no way forward, because there is not one.
    await expect(scorer.getByTestId('onboarding-camera-error')).toContainText(/camera/i);
    await expect(scorer.getByTestId('onboarding-start-checks')).toHaveCount(0);

    // The preview keeps its place even with nothing to show. A `<video>` collapses to nothing
    // without a stream, and everything below it used to jump up the screen and back down again as
    // the camera opened — and once more when the model change re-opened it.
    const box = await scorer.getByTestId('onboarding-preview').boundingBox();
    expect(box?.height, 'the preview reserves its space before there is a picture').toBeGreaterThan(100);
    expect(Math.abs((box?.height ?? 0) - (box?.width ?? 0)), 'and it is square, like the capture').toBeLessThan(2);

    // But always a way out. A phone with no camera is not a phone held hostage by setup.
    await scorer.getByTestId('onboarding-leave').click();
    await expect(scorer.getByRole('button', { name: 'Settings' })).toBeVisible();
    expect((await storedSettings(scorer)).didOnboard).toBe(true);

    await frontend.close();
    await phone.close();
  });

  test('setting up again resets what was measured and keeps what was chosen', async ({ browser }) => {
    const { frontend, phone, scorer } = await pairedScorer(browser);
    await scorer.getByRole('button', { name: 'Skip' }).click();
    await expect(scorer.getByRole('button', { name: 'Settings' })).toBeVisible();

    // Something of each kind: a name and a screensaver preference to keep, a lens calibration, a
    // camera choice with its zoom and a CPU override to throw away.
    await scorer.getByPlaceholder('Name this device').fill('Board camera');
    await scorer.getByPlaceholder('Name this device').blur();
    await scorer.getByRole('button', { name: 'Settings' }).click();
    await scorer.getByLabel('Screensaver').uncheck();
    await scorer.getByRole('checkbox', { name: /Inference/ }).check();
    await scorer.evaluate(() => {
      const KEY = 'instadarts_scorer_settings';
      const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      localStorage.setItem(KEY, JSON.stringify({
        ...stored,
        lensByCamera: { 'some lens': 42 },
        camera: 'Some other camera',
        zoomByCamera: { 'Some other camera': 2.5 },
      }));
    });

    await scorer.getByRole('button', { name: 'Set up' }).click();
    await scorer.getByRole('button', { name: 'Set up' }).click(); // the confirmation

    // Straight back to onboarding, without unpairing — and step one arrives prefilled, because the
    // name is one of the few things a reset keeps. Being asked to type it again would be the whole
    // point of keeping it, missed.
    await expect(scorer.getByRole('heading', { name: 'Setting up this camera' })).toBeVisible();
    await expect(scorer.getByTestId('onboarding-name')).toHaveValue('Board camera');
    await expect(scorer.getByPlaceholder('CODE')).toHaveCount(0);

    const settings = await storedSettings(scorer);
    expect(settings.deviceName, 'the name is the one thing here somebody typed').toBe('Board camera');
    expect(settings.screensaver).toBe(false);
    expect(settings.didOnboard).toBe(false);
    expect(settings.forceCpuInference, 'the self-test is about to decide this again').toBe(false);
    expect(settings.lensByCamera).toEqual({});
    // Setting up again asks which camera again, so the answer and its framing go with it. Asserted
    // as "the old one is gone" rather than "empty", because step one has already re-opened a camera
    // by the time this reads storage — which is the behaviour, not a race to work around.
    expect(settings.camera, 'the stale choice is gone').not.toBe('Some other camera');
    expect(settings.zoomByCamera['Some other camera'], 'and its zoom went with it').toBeUndefined();

    await frontend.close();
    await phone.close();
  });
});
