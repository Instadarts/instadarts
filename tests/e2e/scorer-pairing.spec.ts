import { test, expect, type Page, type Browser } from '@playwright/test';

// ============================================================
// Helpers
// ============================================================

/** Open the top bar's device panel and start pairing; returns the code it shows. */
async function requestPairingCode(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Cameras' }).first().click();
  await page.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = page.locator('p.font-mono.tracking-\\[0\\.3em\\]');
  await expect(code).toBeVisible();
  const text = await code.textContent();
  return (text ?? '').trim();
}

async function openScorer(browser: Browser) {
  const context = await browser.newContext();
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

    await expect(scorer.page.getByText('Ready — no match running')).toBeVisible();
    await expect(player.getByText('connected')).toBeVisible();

    // A code pairs one device, so pairing one ends the exercise: the dialog closes rather than
    // sitting on "Requesting a code…" or minting a second code nobody asked for. Another device
    // means pressing the button again.
    await expect(player.getByText('Requesting a code…')).toHaveCount(0);
    await expect(player.locator('p.font-mono.tracking-\\[0\\.3em\\]')).toHaveCount(0);
    await expect(player.getByRole('button', { name: 'Pair scoring device' })).toBeVisible();

    // And it still works a second time, from the panel it left open.
    await player.getByRole('button', { name: 'Pair scoring device' }).click();
    await expect(player.locator('p.font-mono.tracking-\\[0\\.3em\\]')).toBeVisible();

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
    await expect(scorer.page.getByText('Ready — no match running')).toBeVisible();

    await scorer.page.reload();
    await player.reload();

    // Neither side asks anyone to pair again: the device still has its token, the browser still
    // has the hash, and that is all the server needs to recognise them.
    await expect(scorer.page.getByPlaceholder('CODE')).toHaveCount(0);
    await expect(scorer.page.getByText('Ready — no match running')).toBeVisible();

    await player.getByRole('button', { name: 'Cameras' }).first().click();
    await expect(player.getByText('connected')).toBeVisible();

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
    await expect(player.getByText('Camera 1')).toBeVisible();

    await scorer.page.getByPlaceholder('Name this device').fill('Board camera');
    await scorer.page.getByPlaceholder('Name this device').blur();

    await expect(player.getByText('Board camera')).toBeVisible();
    await expect(player.getByText('Camera 1')).toHaveCount(0);

    // And it is the device's own name, so it survives a reload of both.
    await scorer.page.reload();
    await player.reload();
    await player.getByRole('button', { name: 'Cameras' }).first().click();
    await expect(player.getByText('Board camera')).toBeVisible();

    await frontend.close();
    await scorer.context.close();
  });

  test('a device unpairs itself and pairs with another browser', async ({ browser }) => {
    const frontend = await browser.newContext();
    const player = await frontend.newPage();
    await player.goto('/');

    const scorer = await openScorer(browser);
    await pairScorer(scorer.page, await requestPairingCode(player));
    await expect(player.getByText('connected')).toBeVisible();

    // Named first, to show that unpairing takes the identity and leaves everything describing the
    // phone itself.
    await scorer.page.getByPlaceholder('Name this device').fill('Board camera');
    await scorer.page.getByPlaceholder('Name this device').blur();
    await scorer.page.getByRole('button', { name: 'Settings' }).click();
    await scorer.page.getByLabel('Screensaver').uncheck();

    await scorer.page.getByRole('button', { name: 'Unpair' }).click();
    await scorer.page.getByRole('button', { name: 'Unpair' }).click(); // the confirmation
    await expect(scorer.page.getByPlaceholder('CODE')).toBeVisible();

    // A different browser now, with no reload in between: the socket has to have been unbound.
    const other = await browser.newContext();
    const newOwner = await other.newPage();
    await newOwner.goto('/');
    await pairScorer(scorer.page, await requestPairingCode(newOwner));
    await expect(scorer.page.getByText('Ready — no match running')).toBeVisible();
    await expect(newOwner.getByText('connected')).toBeVisible();

    // The name and the settings both survived: they describe this phone on this mount, and none of
    // that changed by it being handed to somebody else. The new owner is told the name at once,
    // rather than being left with the placeholder it invented.
    await expect(scorer.page.getByPlaceholder('Name this device')).toHaveValue('Board camera');
    await expect(newOwner.getByText('Board camera')).toBeVisible();

    await scorer.page.getByRole('button', { name: 'Settings' }).click();
    await expect(scorer.page.getByLabel('Screensaver')).not.toBeChecked();

    // And the browser it left holds a device that will never come back: it is told nothing about
    // the unpairing, so what it sees is a phone that went offline and stayed there. Its device
    // panel has been open since it showed the code, so there is nothing to open here.
    await expect(player.getByText('offline')).toBeVisible();

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
    await expect(tabA.getByText('connected')).toBeVisible();

    // A second tab of the same browser: paired already (localStorage), not active (sessionStorage).
    const tabB = await frontend.newPage();
    await tabB.goto('/');
    await tabB.getByRole('button', { name: 'Cameras' }).first().click();
    await expect(tabB.getByText('not in use here')).toBeVisible();

    await tabB.getByRole('button', { name: 'Use here' }).click();
    await expect(tabB.getByText('connected')).toBeVisible();
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
    await expect(player.getByText('connected')).toBeVisible();

    const stranger = await browser.newContext();
    const strangerPage = await stranger.newPage();
    await strangerPage.goto('/');
    await strangerPage.getByRole('button', { name: 'Cameras' }).first().click();
    await expect(strangerPage.getByText('No scoring devices paired to this browser yet.')).toBeVisible();

    // And the real owner still has it.
    await expect(player.getByText('connected')).toBeVisible();

    await frontend.close();
    await scorer.context.close();
    await stranger.close();
  });
});
