// Walking out, from a lobby and from a match — and what that leaves behind for everyone else.

import { test, expect } from '@playwright/test';
import { clickT20, submitVisit } from './appHelpers';

test.describe('Lobby leave scenarios', () => {
  test('creator leaves → joiner sees lobby abandoned', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Creator creates online match and adds self
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page1.click('button:has-text("Add")');

    const code = await page1.locator('text=Invite Code').locator('..').locator('code').textContent();
    expect(code).toBeTruthy();

    // Joiner joins
    await page2.goto('/');
    await page2.waitForTimeout(1000);
    await page2.click('text=Join Online Match');
    await page2.getByRole('textbox', { name: 'Invite code', exact: true }).fill(code!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    // Joiner adds themselves
    await page2.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
    await page2.click('button:has-text("Add")');

    // Creator leaves
    await page1.click('text=Leave');
    await page1.waitForURL('/');

    // Joiner should be back on home screen (lobby abandoned)
    await page2.waitForURL('/');
    await expect(page2.locator('text=Local Match')).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('joiner leaves → creator sees player removed and code refreshed', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Creator creates online match and adds self
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page1.click('button:has-text("Add")');

    const code = await page1.locator('text=Invite Code').locator('..').locator('code').textContent();
    expect(code).toBeTruthy();

    // Joiner joins
    await page2.goto('/');
    await page2.waitForTimeout(1000);
    await page2.click('text=Join Online Match');
    await page2.getByRole('textbox', { name: 'Invite code', exact: true }).fill(code!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    // Joiner adds themselves
    await page2.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
    await page2.click('button:has-text("Add")');
    await expect(page1.locator('text=Bob')).toBeVisible({ timeout: 5000 });

    // Joiner leaves
    await page2.click('text=Leave');
    await page2.waitForURL('/');

    // Creator should see Bob removed
    await expect(page1.locator('text=Bob')).not.toBeVisible({ timeout: 5000 });
    // And invite code should be visible again (regenerated)
    await expect(page1.locator('text=Invite Code')).toBeVisible();

    await ctx1.close();
    await ctx2.close();
  });

  test('joiner leaves → stays on home screen (no stale lobby_state rebind)', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Creator creates online match and adds self
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page1.click('button:has-text("Add")');

    const code = await page1.locator('text=Invite Code').locator('..').locator('code').textContent();
    expect(code).toBeTruthy();

    // Joiner joins
    await page2.goto('/');
    await page2.waitForTimeout(1000);
    await page2.click('text=Join Online Match');
    await page2.getByRole('textbox', { name: 'Invite code', exact: true }).fill(code!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    // Joiner adds themselves
    await page2.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
    await page2.click('button:has-text("Add")');

    // Joiner leaves — should go to home
    await page2.click('text=Leave');
    await page2.waitForURL('/');
    await expect(page2.getByRole('heading', { name: 'InstaDarts' })).toBeVisible({ timeout: 5000 });

    // Verify joiner STAYS on home (no stale lobby_state re-navigation)
    await page2.waitForTimeout(1500);
    await expect(page2.getByRole('heading', { name: 'InstaDarts' })).toBeVisible();

    await ctx1.close();
    await ctx2.close();
  });
});

test.describe('In-match leave scenarios', () => {
  test('player leaves during match → other player wins', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Creator creates online match and adds self
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page1.click('button:has-text("Add")');

    const code = await page1.locator('text=Invite Code').locator('..').locator('code').textContent();
    expect(code).toBeTruthy();

    // Joiner joins
    await page2.goto('/');
    await page2.waitForTimeout(1000);
    await page2.click('text=Join Online Match');
    await page2.getByRole('textbox', { name: 'Invite code', exact: true }).fill(code!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });
    await page2.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
    await page2.click('button:has-text("Add")');
    await expect(page1.locator('text=Bob')).toBeVisible({ timeout: 5000 });

    // Start match
    await page1.click('button:has-text("Start Match")');
    await page1.waitForURL('**/match/**');
    await page2.waitForURL('**/match/**');
    await expect(page1.locator('text=501').first()).toBeVisible();
    await expect(page2.locator('text=501').first()).toBeVisible();

    // Alice throws one visit
    await clickT20(page1); await clickT20(page1); await clickT20(page1);
    await submitVisit(page1);

    // Alice leaves the match
    await page1.getByRole('button', { name: 'Leave', exact: true }).click();
    await page1.waitForURL('/');

    // Bob should be declared winner
    await expect(page2.locator('text=Bob wins!')).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });
});
