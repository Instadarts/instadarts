import { test, expect, type Page, type Browser } from '@playwright/test';
import {
  closeScorerSettings,
  openScorerSettings,
  pairingCode,
  renameScorerDevice,
  scorerDeviceName,
  skipOnboarding,
} from './appHelpers';

// ============================================================
// Helpers
// ============================================================

/** Open the top bar's device panel and start pairing; returns the code it shows. */
async function requestPairingCode(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Cameras' }).first().click();
  await page.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = pairingCode(page);
  await expect(code).toBeVisible();
  const text = await code.textContent();
  return (text ?? '').trim();
}

async function openScorer(browser: Browser) {
  const context = await browser.newContext();
  await skipOnboarding(context);
  const page = await context.newPage();
  await page.goto('/scorer');
  return { context, page };
}

async function pairScorer(page: Page, code: string) {
  await page.getByPlaceholder('CODE').fill(code);
  await page.getByRole('button', { name: 'Pair' }).click();
}

// ============================================================
// Tests
// ============================================================

test.describe('scoring device pairing', () => {
  test('a phone pairs with the code the frontend shows and becomes active', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await player.goto('/');

    const code = await requestPairingCode(player);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

    const scorer = await openScorer(browser);
    await pairScorer(scorer.page, code);

    await expect(scorer.page.getByTestId('scorer-status')).toHaveText('Ready — no match running');
    await expect(player.getByTestId('device-status')).toHaveText('connected');

    // A code pairs one device, so pairing one ends the exercise: the dialog closes rather than
    // sitting on "Requesting a code…" or minting a second code nobody asked for. Another device
    // means pressing the button again.
    await expect(player.getByText('Requesting a code…')).toHaveCount(0);
    await expect(pairingCode(player)).toHaveCount(0);
    await expect(player.getByRole('button', { name: 'Pair scoring device' })).toBeVisible();

    // And it still works a second time, from the panel it left open.
    await player.getByRole('button', { name: 'Pair scoring device' }).click();
    await expect(pairingCode(player)).toBeVisible();

    // The scoring screen is the one that spends a whole evening mounted, so it is the one that most
    // wants the browser's chrome out of the way.
    await expect(scorer.page.getByTestId('fullscreen')).toBeVisible();

    await frontend.close();
    await scorer.context.close();
  });

  test('the pairing survives a reload of both sides', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await player.goto('/');
    const code = await requestPairingCode(player);

    const scorer = await openScorer(browser);
    await pairScorer(scorer.page, code);
    await expect(scorer.page.getByTestId('scorer-status')).toHaveText('Ready — no match running');

    await scorer.page.reload();
    await player.reload();

    // Neither side asks anyone to pair again: the device still has its token, the browser still
    // has the hash, and that is all the server needs to recognise them.
    await expect(scorer.page.getByPlaceholder('CODE')).toHaveCount(0);
    await expect(scorer.page.getByTestId('scorer-status')).toHaveText('Ready — no match running');

    await player.getByRole('button', { name: 'Cameras' }).first().click();
    await expect(player.getByTestId('device-status')).toHaveText('connected');

    await frontend.close();
    await scorer.context.close();
  });

  test('naming the device on the phone renames it in the browser', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await player.goto('/');
    const code = await requestPairingCode(player);

    const scorer = await openScorer(browser);
    await pairScorer(scorer.page, code);
    // Until it says otherwise, the browser calls it by the placeholder it assigned at pairing.
    await expect(player.getByTestId('device-name')).toHaveText('Camera 1');

    await renameScorerDevice(scorer.page, 'Board camera');

    await expect(player.getByTestId('device-name')).toHaveText('Board camera');

    // And it is the device's own name, so it survives a reload of both.
    await scorer.page.reload();
    await player.reload();
    await player.getByRole('button', { name: 'Cameras' }).first().click();
    await expect(player.getByTestId('device-name')).toHaveText('Board camera');

    await frontend.close();
    await scorer.context.close();
  });

  test('a device unpairs itself and pairs with another browser', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await player.goto('/');

    const scorer = await openScorer(browser);
    await pairScorer(scorer.page, await requestPairingCode(player));
    await expect(player.getByTestId('device-status')).toHaveText('connected');

    // Named first, to show that unpairing takes the identity and leaves everything describing the
    // phone itself.
    const deviceName = await openScorerSettings(scorer.page);
    await deviceName.fill('Board camera');
    await deviceName.blur();
    await scorer.page.getByLabel('Screensaver').uncheck();

    await scorer.page.getByRole('button', { name: 'Unpair' }).click();
    await scorer.page.getByRole('button', { name: 'Unpair' }).click(); // the confirmation
    await expect(scorer.page.getByPlaceholder('CODE')).toBeVisible();

    // A different browser now, with no reload in between: the socket has to have been unbound.
    const other = await browser.newContext();
    const newOwner = await other.newPage();
    await newOwner.goto('/');
    await pairScorer(scorer.page, await requestPairingCode(newOwner));
    await expect(scorer.page.getByTestId('scorer-status')).toHaveText('Ready — no match running');
    await expect(newOwner.getByTestId('device-status')).toHaveText('connected');

    // The name and the settings both survived: they describe this phone on this mount, and none of
    // that changed by it being handed to somebody else. The new owner is told the name at once,
    // rather than being left with the placeholder it invented.
    await openScorerSettings(scorer.page);
    await expect(scorerDeviceName(scorer.page)).toHaveValue('Board camera');
    await expect(newOwner.getByTestId('device-name')).toHaveText('Board camera');

    await expect(scorer.page.getByLabel('Screensaver')).not.toBeChecked();

    // And the browser it left holds a device that will never come back: it is told nothing about
    // the unpairing, so what it sees is a phone that went offline and stayed there. Its device
    // panel has been open since it showed the code, so there is nothing to open here.
    await expect(player.getByTestId('device-status')).toHaveText('offline');

    await frontend.close();
    await other.close();
    await scorer.context.close();
  });

  test('a wrong code is refused', async ({ browser }) => {
    const scorer = await openScorer(browser);
    await pairScorer(scorer.page, 'ZZZZZZ');
    await expect(scorer.page.getByText('That code was not accepted. Ask for a new one.')).toBeVisible();
    await scorer.context.close();
  });

  test('a second tab grabs the device and the first is told', async ({ browser }) => {
    const frontend = await browser.newContext();
    const tabA = await frontend.newPage();
    await tabA.goto('/');
    const code = await requestPairingCode(tabA);

    const scorer = await openScorer(browser);
    await pairScorer(scorer.page, code);
    await expect(tabA.getByTestId('device-status')).toHaveText('connected');

    // A second tab of the same browser: paired already (localStorage), not active (sessionStorage).
    const tabB = await frontend.newPage();
    await tabB.goto('/');
    await tabB.getByRole('button', { name: 'Cameras' }).first().click();
    await expect(tabB.getByText('not in use here')).toBeVisible();

    await tabB.getByRole('button', { name: 'Use here' }).click();
    await expect(tabB.getByTestId('device-status')).toHaveText('connected');
    await expect(tabA.getByText('not in use here')).toBeVisible();

    await frontend.close();
    await scorer.context.close();
  });

  test('a different browser cannot see or use the pairing', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await player.goto('/');
    const code = await requestPairingCode(player);

    const scorer = await openScorer(browser);
    await pairScorer(scorer.page, code);
    await expect(player.getByTestId('device-status')).toHaveText('connected');

    const stranger = await browser.newContext();
    const strangerPage = await stranger.newPage();
    await strangerPage.goto('/');
    await strangerPage.getByRole('button', { name: 'Cameras' }).first().click();
    await expect(strangerPage.getByText('No scoring devices paired to this browser yet.')).toBeVisible();

    // And the real owner still has it.
    await expect(player.getByTestId('device-status')).toHaveText('connected');

    await frontend.close();
    await scorer.context.close();
    await stranger.close();
  });
});

// ============================================================
// Pairing by scanning
// ============================================================
//
// The QR carries the same six characters the dialog prints, wrapped in a url the phone can simply
// open. Nothing about the pairing itself changes — these tests are about the phone arriving at the
// scoring page with a code already in hand instead of somebody typing one.

test.describe('pairing by scanning', () => {
  test('a scanned link pairs the phone with nobody typing anything', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await player.goto('/');
    const code = await requestPairingCode(player);

    // The dialog offers the code as something to point a camera at, beside the characters.
    await expect(player.getByRole('img', { name: 'Pairing code, as a QR code' })).toBeVisible();

    // What scanning that does: open the scoring page with the code already attached. Seeded as
    // already set up, like every other scorer spec: this is about the route into pairing, not about
    // what a brand-new phone is shown next — and setup has no status badge to read.
    const context = await browser.newContext();
    await skipOnboarding(context);
    const scorer = await context.newPage();
    await scorer.goto(`/scorer?code=${code}`);

    // No code field, no Pair button — it is already somebody's camera.
    await expect(scorer.getByTestId('scorer-status')).toHaveText('Ready — no match running');
    await expect(player.getByTestId('device-status')).toHaveText('connected');
    await expect(scorer.getByPlaceholder('CODE')).toHaveCount(0);

    // And the code is out of the address bar. It is single-use, so a phone that restores this tab
    // tomorrow morning must not open on a refusal about a code its owner never saw.
    await expect.poll(() => scorer.evaluate(() => window.location.search)).toBe('');
    await expect.poll(() => scorer.evaluate(() => window.location.pathname)).toBe('/scorer');

    await frontend.close();
    await context.close();
  });

  test('a bad code in the link leaves the phone on the ordinary pairing screen', async ({ browser }) => {
    const context = await browser.newContext();
    const scorer = await context.newPage();
    // Right shape, never minted — so it reaches the server and is refused, rather than being
    // discarded as malformed before it is sent.
    await scorer.goto('/scorer?code=ZZZZZZ');

    await expect(scorer.getByPlaceholder('CODE')).toBeVisible();
    await expect.poll(() => scorer.evaluate(() => window.location.search)).toBe('');

    await context.close();
  });

  test('a scanned link takes a phone that already belongs to somebody, and keeps its settings', async ({ browser }) => {
    const first = await browser.newContext();
    const owner = await first.newPage();
    await owner.goto('/');

    const scorer = await openScorer(browser);
    await pairScorer(scorer.page, await requestPairingCode(owner));
    await expect(owner.getByTestId('device-status')).toHaveText('connected');

    // Everything that describes this phone rather than who it answers to.
    const deviceName = await openScorerSettings(scorer.page);
    await deviceName.fill('Board camera');
    await deviceName.blur();
    await scorer.page.getByLabel('Screensaver').uncheck();
    await closeScorerSettings(scorer.page);

    // Somebody else's screen, somebody else's code — and no unpairing first. Scanning is the whole
    // interaction: a phone on a wall should not have to be talked out of its last pairing before it
    // can be given a new one.
    const second = await browser.newContext();
    const newOwner = await second.newPage();
    await newOwner.goto('/');
    const code = await requestPairingCode(newOwner);
    await scorer.page.goto(`/scorer?code=${code}`);

    await expect(scorer.page.getByTestId('scorer-status')).toHaveText('Ready — no match running');
    await expect(newOwner.getByTestId('device-status')).toHaveText('connected');
    await expect(newOwner.getByTestId('device-name')).toHaveText('Board camera');

    // The settings are untouched: they describe this camera on this mount, and none of that changed
    // by it being handed to somebody else.
    await openScorerSettings(scorer.page);
    await expect(scorerDeviceName(scorer.page)).toHaveValue('Board camera');
    await expect(scorer.page.getByLabel('Screensaver')).not.toBeChecked();

    // The browser it left is told, rather than being left holding a camera that is simply never
    // heard from again. Its device panel has been open since it showed its code.
    await expect(owner.getByTestId('device-status')).toHaveText('offline');

    await first.close();
    await second.close();
    await scorer.context.close();
  });
});
