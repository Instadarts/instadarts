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
//   9. the optional last step draws what the model sees on the live feed
//
// (7) also checks the compact validation images shipped to the client. This is a pipeline health
// check, not an accuracy benchmark: seven of eight board landmarks is a valid homography, while the
// expected dart-tip count must still be exact.

import { test, expect, type Page, type Browser } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { installFakeCamera, type FakeCameraOptions } from './fakeCamera';
import { cameraPreviewPresentation, openScorerSettings, pairingCode, scorerDeviceName } from './appHelpers';

/** The self-test loads two models and runs a dozen inferences on a CPU; it is not quick. */
const RUN_TIMEOUT = 180_000;

// One scene is enough: this spec never asserts what the camera *shows*. Timings do not care, and
// correctness is checked against the shipped photographs rather than against the feed.
const SCENES = {
  darts: fileURLToPath(new URL('../media/board-three-darts.jpg', import.meta.url)),
};

async function pairedScorer(
  browser: Browser,
  {
    camera = true,
    cameraOptions = { maxWidth: 1280, maxHeight: 720 },
  }: { camera?: boolean; cameraOptions?: FakeCameraOptions } = {},
) {
  const frontend = await browser.newContext();
  const player = await frontend.newPage();
  await player.goto('/');
  await player.getByRole('button', { name: 'Cameras' }).first().click();
  await player.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = (await pairingCode(player).textContent())!.trim();

  // Deliberately *not* seeding didOnboard — a device arriving here for the first time is the case.
  // `camera: false` is a phone with none, or one whose owner refused: no permission, no fake.
  const phone = await browser.newContext(camera ? { permissions: ['camera'] } : {});
  const scorer = await phone.newPage();
  // A common 720p camera shape: it accepts the scorer's preferred width but cannot provide more
  // than 720 rows. The page and every live vision path must agree on the centred 720x720 square.
  if (camera) {
    await installFakeCamera(scorer, SCENES, cameraOptions);
  } else {
    await scorer.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => {
            throw new DOMException('Permission denied', 'NotAllowedError');
          },
          enumerateDevices: async () => [],
          getSupportedConstraints: () => ({}),
          addEventListener: () => {},
          removeEventListener: () => {},
        },
      });
    });
  }
  await scorer.goto('/scorer?e2e=1');
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
    await expect(scorer.getByText('Step 1 of 4 · Naming this device')).toBeVisible();
    await expect(scorer.getByTestId('onboarding-preview')).toHaveCount(0);
    await nameDevice(scorer, 'Board camera');

    // 3. The camera comes next, and opens by itself because this context already granted access —
    // no second button to press. The preview carrying frames is the proof it really opened.
    await expect(scorer.getByText('Step 2 of 4 · Choosing a camera')).toBeVisible();
    // Setup is one screen with one thing to do on it: no status badge, no name field, no Settings.
    await expect(scorerDeviceName(scorer)).toHaveCount(0);
    await expect(scorer.getByRole('button', { name: 'Settings' })).toHaveCount(0);
    await expect(scorer.getByTestId('onboarding-start-checks')).toBeVisible();
    expect(await previewSize(scorer)).toEqual({ width: 960, height: 720 });
    await scorer.getByTestId('onboarding-preview').evaluate((video) => {
      video.dataset.e2eIdentity = 'onboarding-preview';
    });
    // And nothing has been measured: this holds the GPU for a while and asks first.
    await expect(scorer.getByTestId('onboarding-stages')).toHaveCount(0);

    await scorer.getByTestId('onboarding-start-checks').click();
    await expect(scorer.getByText('Step 3 of 4 · Checking what this device can do')).toBeVisible();

    // 4. It reaches a verdict.
    await expect(scorer.getByTestId('onboarding-verdict')).toBeVisible({ timeout: RUN_TIMEOUT });
    await expect(scorer.getByTestId('onboarding-preview'))
      .toHaveAttribute('data-e2e-identity', 'onboarding-preview');

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
    expect(settings.model, 'a 720p camera has no extra source detail for the 1280 model').toBe('s_960');
    expect(settings.deviceName, 'the name typed in step one').toBe('Board camera');
    expect(settings.camera, 'the camera it opened is the one it will open next time').toBe('Fake board camera');

    // The fake advertises a 720 px maximum shorter side, so onboarding does not waste time testing
    // the 1280 model and leaves the stream at the small model's preferred width.
    await expect(scorer.getByTestId('stage-model1280')).toHaveCount(0);
    expect(await previewSize(scorer)).toEqual({ width: 960, height: 720 });

    // 9. The optional last step, on the way out. The fake camera is showing a real board with three
    // darts in it, so this is the whole feature end to end against the real model: the spider is
    // drawn, every board point is found, and three tips are marked. Nothing here is hardware —
    // which is worth saying, because it is the only part of setup that draws anything.
    await scorer.getByTestId('onboarding-try-board').click();
    await expect(scorer.getByText('Step 4 of 4 · Pointing it at a board')).toBeVisible();
    await expect(scorer.getByTestId('aim-overlay')).toBeVisible({ timeout: RUN_TIMEOUT });
    await expect(scorer.getByTestId('aim-quality')).toHaveAttribute('data-quality', 'full');
    await expect(scorer.getByTestId('aim-quality')).toHaveAttribute('data-points', '8');
    await expect(scorer.getByTestId('aim-tips').locator('> g')).toHaveCount(3);
    await expect(scorer.getByTestId('onboarding-preview'))
      .toHaveAttribute('data-e2e-identity', 'onboarding-preview');

    // **The model is compiled once, and stays compiled.** This preview used to unload and recompile
    // it on every render — forty-one compiles in five seconds — because the camera handle it depends
    // on was a fresh object each time. The overlay looked perfect throughout; the only symptom was a
    // stuttering picture, which no assertion about the drawing would ever have caught.
    const compilesAfterFirstDraw = await scorer.evaluate(() => (window as { __modelCompiles?: number }).__modelCompiles);
    await scorer.waitForTimeout(4000);
    expect(
      await scorer.evaluate(() => (window as { __modelCompiles?: number }).__modelCompiles),
      'the aim preview recompiled the model while it was running',
    ).toBe(compilesAfterFirstDraw);

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

  test('a portrait camera still presents the same centered square viewport', async ({ browser }) => {
    const { frontend, phone, scorer } = await pairedScorer(browser, {
      cameraOptions: { maxWidth: 720, maxHeight: 1280 },
    });
    await nameDevice(scorer);

    const preview = scorer.getByTestId('onboarding-preview');
    await expect.poll(() => previewSize(scorer)).toEqual({ width: 720, height: 960 });
    const presentation = await cameraPreviewPresentation(preview);
    expect(presentation.sourceHeight).toBeGreaterThan(presentation.sourceWidth);
    expect(Math.abs(presentation.viewportWidth - presentation.viewportHeight)).toBeLessThan(2);
    expect(Math.abs(presentation.videoWidth - presentation.viewportInnerWidth)).toBeLessThan(2);
    expect(Math.abs(presentation.videoHeight - presentation.viewportInnerHeight)).toBeLessThan(2);
    expect(presentation).toMatchObject({
      objectFit: 'cover',
      objectPosition: '50% 50%',
      position: 'absolute',
    });

    await scorer.getByRole('button', { name: 'Skip' }).click();
    await expect(scorer.getByRole('button', { name: 'Settings' })).toBeVisible();
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

  test('the last step is optional — Done from the results leaves without it', async ({ browser }) => {
    test.setTimeout(RUN_TIMEOUT + 60_000);
    const { frontend, phone, scorer } = await pairedScorer(browser);
    await nameDevice(scorer);
    await scorer.getByTestId('onboarding-start-checks').click();
    await expect(scorer.getByTestId('onboarding-verdict')).toBeVisible({ timeout: RUN_TIMEOUT });

    // Both are offered; taking the plain one goes straight to scoring, and nothing loads a model to
    // draw with on the way.
    await expect(scorer.getByTestId('onboarding-try-board')).toBeVisible();
    await scorer.getByTestId('onboarding-leave').click();
    await expect(scorer.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(scorer.getByTestId('aim-overlay')).toHaveCount(0);
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
    expect(Math.abs((box?.height ?? 0) - (box?.width ?? 0)), 'and it is square, like the model input').toBeLessThan(2);

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
    const deviceName = await openScorerSettings(scorer);
    await deviceName.fill('Board camera');
    await deviceName.blur();
    await scorer.getByLabel('Screensaver').uncheck();
    await scorer.getByRole('switch', { name: /^Inference\b/ }).check();
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
