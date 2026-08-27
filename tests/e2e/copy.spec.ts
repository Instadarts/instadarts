import { test, expect, type Page } from '@playwright/test';

// Copying things onto the clipboard: the invite code a player sends an opponent, and the address a
// phone is pointed at to become a camera.
//
// One spec rather than two additions to the pairing and lobby specs, because the interesting part
// is shared and is neither of those things — `components/CopyableText.tsx`, and in particular the
// route it takes when there is no clipboard api at all.

/** Open the top bar's device panel and start pairing. */
async function openPairingDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Cameras' }).first().click();
  await page.getByRole('button', { name: 'Pair scoring device' }).click();
  await expect(page.getByRole('img', { name: 'Pairing code, as a QR code' })).toBeVisible();
}


test.describe('copying the scoring page address', () => {
  test('clicking the address copies it and says so', async ({ browser }) => {
    // Chromium only hands a page the clipboard with these granted; a real browser asks the user.
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const player = await context.newPage();
    await player.goto('/');
    await openPairingDialog(player);

    const address = player.getByRole('button', { name: /\/scorer$/ });
    await expect(address).toBeVisible();
    await address.click();

    await expect(player.getByRole('tooltip', { name: 'Copied' })).toBeVisible();
    expect(await player.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${new URL(player.url()).origin}/scorer`);

    // The acknowledgement is a flash, not a state: it goes away on its own.
    await expect(player.getByRole('tooltip', { name: 'Copied' })).not.toBeVisible({ timeout: 5000 });

    await context.close();
  });

  test('copies even where there is no clipboard api, which is the usual case here', async ({ browser }) => {
    // A phone or a laptop reaching this over the home network is not a secure context, so
    // `navigator.clipboard` is simply absent — the same rule that stops the scoring device opening
    // its camera. Localhost *is* secure, so the only way to exercise the path real users take is to
    // take the api away.
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const player = await context.newPage();
    await player.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    });
    await player.goto('/');
    await openPairingDialog(player);

    expect(await player.evaluate(() => navigator.clipboard)).toBeUndefined();
    await player.getByRole('button', { name: /\/scorer$/ }).click();

    // Copied, not "Select it and copy by hand" — the fallback did the work.
    await expect(player.getByRole('tooltip', { name: 'Copied' })).toBeVisible();

    await context.close();
  });
});

test.describe('copying the invite code', () => {
  test('the code and the share link both copy, and both say so', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const host = await context.newPage();
    await host.goto('/');
    await host.getByRole('button', { name: 'Online Match', exact: true }).click();

    const code = (await host.locator('text=Invite Code').locator('..').locator('code').textContent())!.trim();
    expect(code).toMatch(/^[A-Z0-9]{4,8}$/);

    // The code and the clipboard glyph are one target, so clicking the code itself copies.
    await host.getByRole('button', { name: new RegExp(`^${code}`) }).click();
    await expect(host.getByRole('tooltip', { name: 'Copied' })).toBeVisible();
    expect(await host.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await expect(host.getByRole('tooltip', { name: 'Copied' })).not.toBeVisible({ timeout: 5000 });

    // The share link copies the whole address, not the path it displays.
    await host.getByRole('button', { name: `/lobby/join/${code}` }).click();
    await expect(host.getByRole('tooltip', { name: 'Copied' })).toBeVisible();
    expect(await host.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${new URL(host.url()).origin}/lobby/join/${code}`);

    await context.close();
  });
});
