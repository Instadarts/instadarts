// Getting in and staying in: the home screen's three ways to start, the ids that lead nowhere,
// and what survives a page reload.

import { test, expect } from '@playwright/test';
import { clickT20, submitVisit, expectVisitTotal, setupLocalMatch } from './appHelpers';

test.describe('Home screen', () => {
  test('shows three match options', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('InstaDarts');
    await expect(page.locator('text=Local Match')).toBeVisible();
    await expect(page.locator('text=Create Online Match')).toBeVisible();
    await expect(page.locator('text=Join Online Match')).toBeVisible();
  });

  test('join online match shows invite code input', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Join Online Match');
    await expect(page.locator('input[placeholder="Invite code"]')).toBeVisible();
    await page.click('text=Back');
    await expect(page.locator('text=Local Match')).toBeVisible();
  });

  test('invalid invite code redirects to home', async ({ page }) => {
    await page.goto('/lobby/join/DOESNOTEXIST');
    await page.waitForURL('/', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'InstaDarts' })).toBeVisible();
  });

  test('non-existent lobby redirects to home', async ({ page }) => {
    await page.goto('/lobby/nonexistent-id');
    await page.waitForURL('/', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'InstaDarts' })).toBeVisible();
  });

  test('non-existent match redirects to home', async ({ page }) => {
    await page.goto('/match/nonexistent-id');
    await page.waitForURL('/', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'InstaDarts' })).toBeVisible();
  });

  test('joining a full lobby redirects to home', async ({ browser }) => {
    // A lobby fills at players, not at users: the host holds the whole roster here, and the door is
    // shut on the strength of that alone. No shipped mode caps itself any more, so five is the
    // deployment's number and the only one there is.
    //
    // The user cap — a lobby refusing somebody who could never take a place — is the other half of
    // the same rule, and is asserted directly in tests/unit/nplayers.test.ts rather than by opening
    // five browsers here.
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    // Read before filling: a full lobby has nothing left to sell, so the code comes off the screen.
    const code = await page1.locator('code').textContent();
    expect(code).toBeTruthy();

    for (const name of ['Bob', 'Carol', 'Dave', 'Eve']) {
      await page1.fill('input[placeholder="New player name"]', name);
      await page1.click('button:has-text("Add")');
      await expect(page1.getByText(name, { exact: true })).toBeVisible();
    }
    await expect(page1.getByText('Full — 5 max', { exact: true })).toBeVisible();

    // A joiner arriving at a full lobby is turned round rather than parked in it.
    await page2.goto(`/lobby/join/${code!.trim()}`);
    await page2.waitForURL('/', { timeout: 10000 });
    await expect(page2.getByRole('heading', { name: 'InstaDarts' })).toBeVisible();

    await ctx1.close();
    await ctx2.close();
  });

  test('online lobby: each user holds exactly their own player', async ({ browser }) => {
    // Whose player is whose used to be read off `players[].sessionId`, which is no longer on the
    // wire — the answer is `yourPlayerIds` now, and this is the screen that shows it.
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto('/');
    await page1.click('text=Create Online Match');
    // Four from the host and one from the joiner fills the lobby at five, which is what makes the
    // "no second one to add" half of this test observable at all.
    for (const name of ['Alice', 'Carol', 'Dave', 'Eve']) {
      await page1.fill('input[placeholder="New player name"]', name);
      await page1.click('button:has-text("Add")');
    }

    const code = await page1.locator('code').textContent();
    await page2.goto(`/lobby/join/${code!.trim()}`);
    await page2.fill('input[placeholder="New player name"]', 'Bob');
    await page2.click('button:has-text("Add")');
    await expect(page2.getByText('Alice', { exact: true })).toBeVisible({ timeout: 10000 });

    // Their own to remove, everyone else's to kick — and nothing left to add on either screen.
    await expect(page1.locator('button[title="Remove player"]')).toHaveCount(4);
    await expect(page1.locator('button[title="Kick player"]')).toHaveCount(1);
    await expect(page2.locator('button[title="Remove player"]')).toHaveCount(1);
    await expect(page2.locator('button[title="Kick player"]')).toHaveCount(0);
    await expect(page1.locator('input[placeholder="New player name"]')).toHaveCount(0);
    await expect(page2.locator('input[placeholder="New player name"]')).toHaveCount(0);

    // And it really is their own: the host's ✕ takes one of theirs off, on both screens.
    await page1.locator('button[title="Remove player"]').first().click();
    await expect(page2.locator('text=5th')).toHaveCount(0, { timeout: 5000 });
    await expect(page2.locator('button[title="Remove player"]')).toHaveCount(1);
    await expect(page1.locator('button[title="Remove player"]')).toHaveCount(3);
    await expect(page1.locator('input[placeholder="New player name"]')).toBeVisible();

    await ctx1.close();
    await ctx2.close();
  });

  test('creator can reorder players', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Local Match');

    // Add two players
    await page.fill('input[placeholder="New player name"]', 'Alice');
    await page.click('button:has-text("Add")');
    await page.fill('input[placeholder="New player name"]', 'Bob');
    await page.click('button:has-text("Add")');

    // Alice should be 1st
    const aliceRow = page.locator('text=Alice').locator('..');
    await expect(aliceRow.locator('text=1st')).toBeVisible();

    // Click move down on Alice
    await aliceRow.locator('button[title="Move down"]').click();

    // Now Bob should be 1st
    const bobRow = page.locator('text=Bob').locator('..');
    await expect(bobRow.locator('text=1st')).toBeVisible({ timeout: 3000 });

    // Move Bob down
    await bobRow.locator('button[title="Move down"]').click();
    await expect(aliceRow.locator('text=1st')).toBeVisible({ timeout: 3000 });
  });
  test('local lobby survives page reload', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Local Match');

    // Add a player
    await page.fill('input[placeholder="New player name"]', 'Alice');
    await page.click('button:has-text("Add")');
    await expect(page.locator('text=Alice')).toBeVisible();
    await page.waitForTimeout(300);

    // Verify reconnect info is in sessionStorage
    const saved = await page.evaluate(() => sessionStorage.getItem('instadarts_reconnect'));
    expect(saved).toBeTruthy();

    // Reload
    await page.reload();
    await page.waitForTimeout(3000);

    // Should still be in the lobby with Alice visible
    await expect(page.locator('h2')).toContainText('Local Match', { timeout: 10000 });
    await expect(page.locator('text=Alice')).toBeVisible({ timeout: 5000 });
  });

  test('local lobby without players survives page reload', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Local Match');
    await expect(page.locator('h2')).toContainText('Local Match');

    // Reload without adding any players
    await page.reload();
    await page.waitForTimeout(3000);

    // Should still be in the empty lobby
    await expect(page.locator('h2')).toContainText('Local Match', { timeout: 10000 });
    // Should be able to add a player after reload
    await page.fill('input[placeholder="New player name"]', 'Alice');
    await page.click('button:has-text("Add")');
    await expect(page.locator('text=Alice')).toBeVisible({ timeout: 5000 });
  });

  test('match survives page reload', async ({ page }) => {
    await setupLocalMatch(page, ['Alice', 'Bob'], 501);

    // Alice throws one visit
    await clickT20(page); await clickT20(page); await clickT20(page);
    await submitVisit(page);
    await expectVisitTotal(page, 180);

    // Reload
    await page.reload();
    await page.waitForTimeout(3000);

    // Back in the match — still being played, with the visit history intact.
    await expect(page.locator('text=Visit History')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Match cancelled')).toHaveCount(0);
    await expect(page.getByText('321', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('= 180').first()).toBeVisible({ timeout: 5000 });
  });
});
