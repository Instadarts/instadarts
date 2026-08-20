import { test, expect } from '@playwright/test';
import { clickT20, submitVisit } from './appHelpers';

test.describe('N-players matches', () => {
  test('3-player local match with Count-Up mode', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Local Match');

    // Switch to Count-Up
    const selector = page.getByLabel('Game');
    await selector.selectOption('count-up');

    // Add 3 players
    for (const name of ['Alice', 'Bob', 'Carol']) {
      await page.fill('input[placeholder="New player name"]', name);
      await page.click('button:has-text("Add")');
      await expect(page.locator(`text=${name}`)).toBeVisible();
    }

    // Start match
    await page.click('text=Start Match');
    await page.waitForURL('**/match/**');

    // All 3 players should have cards
    await expect(page.locator('[data-player="Alice"]')).toBeVisible();
    await expect(page.locator('[data-player="Bob"]')).toBeVisible();
    await expect(page.locator('[data-player="Carol"]')).toBeVisible();

    // Alice is up first
    await expect(page.locator('[data-player="Alice"]').locator('text=▶ throwing')).toBeVisible();
    await clickT20(page);
    await submitVisit(page);

    // Bob is up second
    await expect(page.locator('[data-player="Bob"]').locator('text=▶ throwing')).toBeVisible();
    await clickT20(page);
    await submitVisit(page);

    // Carol is up third
    await expect(page.locator('[data-player="Carol"]').locator('text=▶ throwing')).toBeVisible();
    await clickT20(page);
    await submitVisit(page);

    // Back to Alice
    await expect(page.locator('[data-player="Alice"]').locator('text=▶ throwing')).toBeVisible();
  });

  test('multi-player per online user with leaver rules', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const host = await ctx1.newPage();
    const guest = await ctx2.newPage();

    // Host creates online match
    await host.goto('/');
    await host.click('text=Online Match');

    // Switch to Count-Up
    const selector = host.getByLabel('Game');
    await selector.selectOption('count-up');

    // Host adds Alice and Carol
    await host.fill('input[placeholder="New player name"]', 'Alice');
    await host.click('button:has-text("Add")');
    await host.fill('input[placeholder="New player name"]', 'Carol');
    await host.click('button:has-text("Add")');

    // Get invite code
    const code = (await host.locator('code').textContent())?.trim();
    expect(code).toBeTruthy();

    // Guest joins
    await guest.goto(`/lobby/join/${code}`);
    await guest.fill('input[placeholder="New player name"]', 'Bob');
    await guest.click('button:has-text("Add")');

    // Host starts match
    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');

    // Both see 3 players: Alice, Carol, Bob
    await expect(guest.locator('[data-player="Alice"]')).toBeVisible();
    await expect(guest.locator('[data-player="Carol"]')).toBeVisible();
    await expect(guest.locator('[data-player="Bob"]')).toBeVisible();

    // Host (controlling Alice and Carol) leaves the match
    await host.click('text=Leave Match');
    await host.waitForURL('/');

    // Guest should now see match finished with Bob as WINNER
    await expect(guest.locator('text=Bob wins!')).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });
});
