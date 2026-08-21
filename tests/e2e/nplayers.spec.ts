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

  test('5-player local x01 match, panel component included', async ({ page }) => {
    // x01 is the default mode and declares no cap of its own, so a plain local lobby already takes
    // the deployment's five. This is the shape a person actually plays; count-up above is dev-only.
    await page.goto('/');
    await page.click('text=Local Match');

    const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];
    for (const name of names) {
      await page.fill('input[placeholder="New player name"]', name);
      await page.click('button:has-text("Add")');
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Full — 5 max', { exact: true })).toBeVisible();

    await page.click('text=Start Match');
    await page.waitForURL('**/match/**');

    // A score card each, and — from x01's own panel file — a statistics card each beside them. That
    // second count is the one worth having: the component derives its cards from the panel rows
    // rather than from a player count it was told, and this is where that is actually exercised.
    for (const name of names) await expect(page.locator(`[data-player="${name}"]`)).toBeVisible();
    await expect(page.getByText('3-dart average', { exact: true })).toHaveCount(5);

    // Five independent countdowns: a visit comes off the thrower's score and nobody else's.
    await expect(page.locator('[data-player="Alice"]').locator('text=▶ throwing')).toBeVisible();
    await clickT20(page);
    await submitVisit(page);

    await expect(page.locator('[data-player="Alice"]')).toContainText('441');
    await expect(page.locator('[data-player="Bob"]')).toContainText('501');
    await expect(page.locator('[data-player="Eve"]')).toContainText('501');
    await expect(page.locator('[data-player="Bob"]').locator('text=▶ throwing')).toBeVisible();
  });

  test('three users get a match but no video mesh', async ({ browser }) => {
    // A third board is a topology the mesh was never built for, so the server creates no session at
    // all — and the screen says so, or missing video reads as a fault rather than as a decision.
    const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
    const [host, second, third] = await Promise.all(contexts.map((ctx) => ctx.newPage()));

    await host.goto('/');
    await host.click('text=Online Match');
    await host.getByLabel('Game').selectOption('count-up');
    await host.fill('input[placeholder="New player name"]', 'Alice');
    await host.click('button:has-text("Add")');

    const code = (await host.locator('code').textContent())!.trim();
    for (const [page, name] of [[second, 'Bob'], [third, 'Carol']] as const) {
      await page.goto(`/lobby/join/${code}`);
      await page.fill('input[placeholder="New player name"]', name);
      await page.click('button:has-text("Add")');
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    // Three of a possible five, counted by the lobby itself.
    await expect(host.getByText('3/5', { exact: true })).toBeVisible();

    await host.click('text=Start Match');
    await Promise.all([host, second, third].map((page) => page.waitForURL('**/match/**')));

    for (const page of [host, second, third]) {
      await expect(page.locator('[data-player="Alice"]')).toBeVisible();
      await expect(page.locator('[data-player="Bob"]')).toBeVisible();
      await expect(page.locator('[data-player="Carol"]')).toBeVisible();
      await expect(page.locator('text=video off — more than two boards')).toBeVisible();
    }

    await Promise.all(contexts.map((ctx) => ctx.close()));
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
