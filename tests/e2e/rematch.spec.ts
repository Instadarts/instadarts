// Playing again: the three-way vote, and the fresh match it starts.

import { test, expect, type Page } from '@playwright/test';
import { winLegAt501, setupLocalMatch } from './appHelpers';

test.describe('Re-match', () => {
  /** One leg at 501 is the whole match at the default format. */
  async function playToAWin(alice: Page, bob: Page = alice) {
    await winLegAt501(alice, bob);
    await expect(alice.locator('text=Alice wins!')).toBeVisible();
  }

  test('local: both toggles start a fresh match with the order switched', async ({ page }) => {
    await setupLocalMatch(page, ['Alice', 'Bob'], 501);
    const firstMatch = page.url();
    await playToAWin(page);

    const yes = (name: string) => page.getByRole('button', { name: `${name}: accept re-match` });
    await expect(yes('Alice')).toBeVisible();
    await yes('Alice').click();
    await expect(yes('Alice')).toHaveAttribute('aria-pressed', 'true');
    expect(page.url()).toBe(firstMatch); // one player is not enough

    await yes('Bob').click();
    await page.waitForURL((url) => url.href !== firstMatch);

    // A new match, from scratch, with Bob leading off.
    await expect(page.locator('text=Play again?')).toHaveCount(0);
    await expect(page.locator('[data-player="Alice"]').getByText('501', { exact: true })).toBeVisible();
    await expect(page.locator('[data-player="Bob"]').getByText('501', { exact: true })).toBeVisible();
    await expect(page.locator('[data-player="Bob"]')).toHaveAttribute('aria-current', 'true');

    // The mode's panel is up before the first dart here too. It once was not: a re-match arrives on
    // a broadcast of its own, and that one left the panel out, so the block appeared only after
    // somebody threw.
    await expect(page.locator('text=Round 1')).toBeVisible();
    await expect(page.locator('text=3-DART AVERAGE')).toHaveCount(2);
  });

  test('online: each user answers for their own player', async ({ browser }) => {
    const page1 = await (await browser.newContext()).newPage();
    const page2 = await (await browser.newContext()).newPage();

    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page1.click('button:has-text("Add")');
    const code = (await page1.locator('text=Invite Code').locator('..').locator('code').textContent())!;

    await page2.goto(`/lobby/join/${code.trim()}`);
    await page2.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
    await page2.click('button:has-text("Add")');
    await expect(page1.locator('text=Bob')).toBeVisible({ timeout: 5000 });

    await page1.click('text=Start Match');
    await page1.waitForURL('**/match/**');
    await page2.waitForURL('**/match/**');
    const firstMatch = page1.url();

    await playToAWin(page1, page2);
    await expect(page2.locator('text=Alice wins!')).toBeVisible();

    // Bob's buttons are Bob's to press: Alice sees them, but cannot press them.
    const yes = (page: Page, name: string) =>
      page.getByRole('button', { name: `${name}: accept re-match` });
    await expect(yes(page1, 'Bob')).toBeDisabled();
    await yes(page1, 'Alice').click();
    await expect(yes(page2, 'Alice')).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });
    expect(page2.url()).toBe(firstMatch);

    await yes(page2, 'Bob').click();
    await page1.waitForURL((url) => url.href !== firstMatch);
    await page2.waitForURL((url) => url.href !== firstMatch);
    expect(page1.url()).toBe(page2.url());
  });

  test('a decline settles it, and the summary stays up', async ({ page }) => {
    await setupLocalMatch(page, ['Alice', 'Bob'], 501);
    const firstMatch = page.url();
    await playToAWin(page);

    await page.getByRole('button', { name: 'Alice: accept re-match' }).click();
    await page.getByRole('button', { name: 'Bob: decline re-match' }).click();

    // Settled: no re-match, no further answering, and the summary is still there to read.
    await expect(page.locator('text=No re-match')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Alice: accept re-match' })).toBeDisabled();
    await expect(page.locator('text=Alice wins!')).toBeVisible();
    await expect(page.locator('text=Match History')).toBeVisible();
    expect(page.url()).toBe(firstMatch);
  });

  test('spectators are carried into the re-match', async ({ browser }) => {
    const host = await (await browser.newContext()).newPage();
    await setupLocalMatch(host, ['Alice', 'Bob'], 501);
    const firstMatch = host.url().split('/match/')[1];

    const watcher = await (await browser.newContext()).newPage();
    await watcher.goto(`/spectate/${firstMatch}`);
    await expect(watcher.locator('text=501 — Double Out')).toBeVisible();

    await playToAWin(host);
    // A spectator watches, and has no say.
    await expect(watcher.locator('text=Play again?')).toHaveCount(0);

    await host.getByRole('button', { name: 'Alice: accept re-match' }).click();
    await host.getByRole('button', { name: 'Bob: accept re-match' }).click();

    // Dragged along to the new match, still spectating.
    await watcher.waitForURL((url) => url.href.includes('/spectate/') && !url.href.endsWith(firstMatch));
    await expect(watcher.locator('[data-player="Alice"]').getByText('501', { exact: true })).toBeVisible();
    await expect(watcher.locator('[data-player="Bob"]').getByText('501', { exact: true })).toBeVisible();
    await expect(watcher.locator('text=Submit Visit')).toHaveCount(0); // still read-only
  });

  test('a cancelled match says so, and offers no re-match', async ({ browser }) => {
    const host = await (await browser.newContext()).newPage();
    await setupLocalMatch(host, ['Alice', 'Bob'], 501);
    const matchId = host.url().split('/match/')[1];

    const watcher = await (await browser.newContext()).newPage();
    await watcher.goto(`/spectate/${matchId}`);
    await expect(watcher.locator('text=501 — Double Out')).toBeVisible();

    await host.getByRole('button', { name: 'Leave', exact: true }).click();

    await expect(watcher.locator('text=Match cancelled')).toBeVisible({ timeout: 5000 });
    await expect(watcher.locator('text=wins!')).toHaveCount(0);
    await expect(watcher.locator('text=Play again?')).toHaveCount(0);
  });

  test('a player who leaves is out for good — the other wins, with no re-match', async ({ browser }) => {
    const page1 = await (await browser.newContext()).newPage();
    const page2 = await (await browser.newContext()).newPage();

    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page1.click('button:has-text("Add")');
    const code = (await page1.locator('text=Invite Code').locator('..').locator('code').textContent())!;

    await page2.goto(`/lobby/join/${code.trim()}`);
    await page2.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
    await page2.click('button:has-text("Add")');
    await expect(page1.locator('text=Bob')).toBeVisible({ timeout: 5000 });
    await page1.click('text=Start Match');
    await page1.waitForURL('**/match/**');
    await page2.waitForURL('**/match/**');

    await page1.getByRole('button', { name: 'Leave', exact: true }).click();

    await expect(page2.locator('text=Bob wins!')).toBeVisible({ timeout: 5000 });
    await expect(page2.locator('text=Play again?')).toHaveCount(0);
  });
});
