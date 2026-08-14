// Setting a phone up, end to end, with the real model and the real photographs.
//
// **Written to assert the contract, not a path.** Whether the machine running this has working
// WebGPU is not knowable from inside the test and must never be assumed: CI has none, a developer's
// laptop may, and both are supposed to end up with a working scoring device. So nothing here says
// "expect webgpu" or "expect wasm" — that would be asserting the hardware rather than the feature.
//
// What is asserted is what the self-test promises:
//
//   1. it appears on its own after pairing, with nobody navigating to it
//   2. it reaches a verdict rather than hanging or throwing
//   3. the CPU paths never fail — WebGPU may be absent, may fall back, may win
//   4. it settles on some working configuration and says which
//   5. the two reference boards read 8/0 and 8/3 under whatever it settled on
//
// (5) is also the only thing that checks the downscaled 1280 px images that ship to the client. The
// rest of the suite asserts against the 1920 px originals in tests/media, so if a resize ever spoils
// detection, this is where it surfaces.

import { test, expect, type Page, type Browser } from '@playwright/test';

/** The self-test loads two models and runs a dozen inferences on a CPU; it is not quick. */
const RUN_TIMEOUT = 180_000;

async function pairedScorer(browser: Browser) {
  const frontend = await browser.newContext();
  const player = await frontend.newPage();
  await player.goto('/');
  await player.getByRole('button', { name: 'Cameras' }).first().click();
  await player.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = (await player.locator('p.font-mono.tracking-\\[0\\.3em\\]').textContent())!.trim();

  // Deliberately *not* seeding didOnboard — a device arriving here for the first time is the case.
  const phone = await browser.newContext();
  const scorer = await phone.newPage();
  await scorer.goto('/scorer');
  await scorer.getByPlaceholder('CODE').fill(code);
  await scorer.getByRole('button', { name: 'Pair' }).click();

  return { frontend, player, phone, scorer };
}

/** What this device stored about itself, read straight out of the phone's own settings. */
async function storedSettings(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('instadarts_scorer_settings') ?? '{}'));
}

test.describe('setting up a scoring device', () => {
  test('a freshly paired phone runs the self-test and ends up able to read a board', async ({ browser }) => {
    test.setTimeout(RUN_TIMEOUT + 60_000);
    const { frontend, phone, scorer } = await pairedScorer(browser);

    // 1. It arrives on its own. Nothing below navigated here.
    await expect(scorer.getByRole('heading', { name: 'Setting up this camera' })).toBeVisible();
    await expect(scorer.getByRole('button', { name: 'Start' })).toBeVisible();
    // And nothing has started: this holds the GPU for a while and asks first.
    await expect(scorer.getByTestId('onboarding-stages')).toHaveCount(0);

    await scorer.getByRole('button', { name: 'Start' }).click();

    // 2. It reaches a verdict.
    await expect(scorer.getByTestId('onboarding-verdict')).toBeVisible({ timeout: RUN_TIMEOUT });

    // 3 + 4. Some configuration works, and it is the one now stored. A device that gave up says so
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

    // 5. The photographs read correctly — under whichever paths this machine settled on.
    await expect(scorer.getByTestId('stage-validation')).toContainText('ok');

    // The details are a tap away, and that is where the paths not taken live.
    await scorer.getByRole('button', { name: /Motion detector/ }).click();
    await expect(scorer.getByTestId('stage-motion')).toContainText('cpu:');

    // The decision is persisted, not just displayed.
    const settings = await storedSettings(scorer);
    expect(['s_960', 's_1280']).toContain(settings.model);

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
    await scorer.getByRole('button', { name: 'Start' }).click();

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

  test('setting up again resets what was measured and keeps what was chosen', async ({ browser }) => {
    const { frontend, phone, scorer } = await pairedScorer(browser);
    await scorer.getByRole('button', { name: 'Skip' }).click();
    await expect(scorer.getByRole('button', { name: 'Settings' })).toBeVisible();

    // Something of each kind: a name and a screensaver preference to keep, a lens calibration and a
    // CPU override to throw away.
    await scorer.getByPlaceholder('Name this device').fill('Board camera');
    await scorer.getByPlaceholder('Name this device').blur();
    await scorer.getByRole('button', { name: 'Settings' }).click();
    await scorer.getByLabel('Screensaver').uncheck();
    await scorer.getByRole('checkbox', { name: /Inference/ }).check();
    await scorer.evaluate(() => {
      const KEY = 'instadarts_scorer_settings';
      const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      localStorage.setItem(KEY, JSON.stringify({ ...stored, lensByCamera: { 'some lens': 42 } }));
    });

    await scorer.getByRole('button', { name: 'Set up' }).click();
    await scorer.getByRole('button', { name: 'Set up' }).click(); // the confirmation

    // Straight back to onboarding, without unpairing.
    await expect(scorer.getByRole('heading', { name: 'Setting up this camera' })).toBeVisible();
    await expect(scorer.getByPlaceholder('CODE')).toHaveCount(0);

    const settings = await storedSettings(scorer);
    expect(settings.deviceName, 'the name is the one thing here somebody typed').toBe('Board camera');
    expect(settings.screensaver).toBe(false);
    expect(settings.didOnboard).toBe(false);
    expect(settings.forceCpuInference, 'the self-test is about to decide this again').toBe(false);
    expect(settings.lensByCamera).toEqual({});

    await frontend.close();
    await phone.close();
  });
});
