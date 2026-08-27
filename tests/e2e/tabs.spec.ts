// One browser, the same game open twice.
//
// Separate tabs are separate users — `sessionStorage` is per tab, so each holds its own seat, and
// two of them can play each other. Duplicating a tab is the case that needs a rule: duplication
// copies storage, so the copy arrives holding the original's token, and a place has one occupant.

import { test, expect } from '@playwright/test';
import { clickT20, setupLocalMatch, submitVisit } from './appHelpers';

const RECONNECT_KEY = 'instadarts_reconnect';

test.describe('two tabs of one browser', () => {
  test('play each other as two users', async ({ browser }) => {
    const ctx = await browser.newContext();
    const tabA = await ctx.newPage();
    const tabB = await ctx.newPage();

    await tabA.goto('/');
    await tabA.getByRole('button', { name: 'Online Match', exact: true }).click();
    await tabA.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await tabA.click('button:has-text("Add")');

    const code = await tabA.locator('text=Invite Code').locator('..').locator('code').textContent();
    await tabB.goto(`/lobby/join/${code!.trim()}`);
    await tabB.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
    await tabB.click('button:has-text("Add")');
    await expect(tabA.locator('text=Bob')).toBeVisible({ timeout: 10000 });

    await tabA.click('text=Start Match');
    await tabA.waitForURL('**/match/**');
    await tabB.waitForURL('**/match/**');

    // A visit each, and each tab reloads and keeps its own side.
    await clickT20(tabA); await clickT20(tabA); await clickT20(tabA);
    await submitVisit(tabA);
    await expect(tabB.getByText('321', { exact: true })).toBeVisible({ timeout: 5000 });

    await tabA.reload();
    await tabB.reload();
    await expect(tabA.getByTestId('dartboard')).toBeVisible({ timeout: 10000 });
    await expect(tabB.getByTestId('dartboard')).toBeVisible({ timeout: 10000 });
    await expect(tabA.locator('[data-player="Alice"]').getByText('321', { exact: true })).toBeVisible();
    await expect(tabB.locator('[data-player="Bob"]')).toHaveAttribute('aria-current', 'true');

    await clickT20(tabB); await clickT20(tabB); await clickT20(tabB);
    await submitVisit(tabB);
    await expect(tabA.getByText('321').first()).toBeVisible({ timeout: 5000 });

    await ctx.close();
  });

  test('a duplicated tab takes the game over, and the original says so', async ({ browser }) => {
    const ctx = await browser.newContext();
    const original = await ctx.newPage();

    await setupLocalMatch(original, ['Alice', 'Bob'], 501);
    const matchId = original.url().split('/match/')[1];
    const carried = await original.evaluate((key) => sessionStorage.getItem(key), RECONNECT_KEY);

    // What "Duplicate tab" does: the same URL, and a copy of the storage the seat token lives in.
    const copy = await ctx.newPage();
    await copy.goto('/');
    await copy.evaluate(([key, value]) => sessionStorage.setItem(key, value!), [RECONNECT_KEY, carried] as const);
    await copy.goto(`/match/${matchId}`);
    await expect(copy.getByTestId('dartboard')).toBeVisible({ timeout: 10000 });

    // The original is out of the match, told why, and holding nothing to come back with.
    await expect(original).toHaveURL(/\/$/, { timeout: 10000 });
    await expect(original.getByRole('status').filter({ hasText: 'opened in another tab' })).toBeVisible();
    expect(await original.evaluate((key) => sessionStorage.getItem(key), RECONNECT_KEY)).toBeNull();

    // And it stays that way: nothing sends the original back to take the place off the copy.
    await copy.waitForTimeout(3000);
    await expect(copy.getByTestId('dartboard')).toBeVisible();
    await expect(original).toHaveURL(/\/$/);

    // The copy is the one playing.
    await clickT20(copy); await clickT20(copy); await clickT20(copy);
    await submitVisit(copy);
    await expect(copy.getByText('321', { exact: true })).toBeVisible({ timeout: 5000 });

    await ctx.close();
  });
});
