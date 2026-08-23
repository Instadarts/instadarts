// Watching without playing: what a spectator sees, and what it must not be able to touch.

import { test, expect, type Page } from '@playwright/test';
import { clickT20, submitVisit, setupLocalMatch } from './appHelpers';

const spectatorLabel = (page: Page) => page.getByText(/spectating/i);

test.describe('Spectator mode', () => {
  test('/spectate/:id shows a running match as read-only', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await setupLocalMatch(page1, ['Alice', 'Bob'], 501);
    const matchId = page1.url().split('/match/')[1];
    expect(matchId).toBeTruthy();

    await clickT20(page1); await clickT20(page1); await clickT20(page1);
    await submitVisit(page1);

    await page2.goto(`/spectate/${matchId}`);
    await page2.waitForTimeout(1000);

    await expect(spectatorLabel(page2)).toBeVisible({ timeout: 5000 });
    await expect(page2.locator('text=501').first()).toBeVisible();
    await expect(page2.locator('text=180').first()).toBeVisible();
    await expect(page2.locator('button:has-text("Submit Visit")')).not.toBeVisible({ timeout: 3000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('editing /spectate/:id into /match/:id does not hand over the board', async ({ browser }) => {
    // The whole attack is a keystroke in the address bar, so this is the gesture rather than the
    // message: a page load with whatever the watching tab had saved. Nothing may be resumed from it,
    // because a spectator is never sent a seat to save.
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const player = await ctx1.newPage();
    const watcher = await ctx2.newPage();

    await setupLocalMatch(player, ['Alice'], 501);
    const matchId = player.url().split('/match/')[1];

    await watcher.goto(`/spectate/${matchId}`);
    await expect(spectatorLabel(watcher)).toBeVisible({ timeout: 5000 });

    await watcher.goto(`/match/${matchId}`);
    await watcher.waitForTimeout(1000);

    // No board to throw at, and nothing saved that could have asked for one.
    await expect(watcher.getByTestId('dartboard')).not.toBeVisible({ timeout: 3000 });
    expect(await watcher.evaluate(() => sessionStorage.getItem('instadarts_reconnect'))).toBeNull();

    // The match carries on being Alice's, and her own page is untouched by any of it.
    await clickT20(player); await clickT20(player); await clickT20(player);
    await submitVisit(player);
    await expect(player.getByText('321', { exact: true })).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('spectator cannot interact with lobby', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page1.click('button:has-text("Add")');

    const lobbyId = page1.url().split('/lobby/')[1];
    expect(lobbyId).toBeTruthy();

    await page2.goto(`/spectate/${lobbyId}`);
    await page2.waitForTimeout(1000);

    await expect(spectatorLabel(page2)).toBeVisible({ timeout: 5000 });
    await expect(page2.getByRole('textbox', { name: 'New player', exact: true })).not.toBeVisible({ timeout: 3000 });
    await expect(page2.locator('button:has-text("Start Match")')).not.toBeVisible({ timeout: 3000 });
    await expect(page2.getByRole('combobox', { name: 'Game' })).toBeDisabled();
    await expect(page2.locator('text=Alice')).toBeVisible();
    await expect(page2.locator('button[title="Remove player"]')).not.toBeVisible({ timeout: 3000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('spectator leaving has no effect on the lobby', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page1.click('button:has-text("Add")');

    const lobbyId = page1.url().split('/lobby/')[1];

    await page2.goto(`/spectate/${lobbyId}`);
    await page2.waitForTimeout(1000);
    await expect(spectatorLabel(page2)).toBeVisible({ timeout: 5000 });

    await page2.click('text=Leave');
    await page2.waitForURL('/');

    await expect(page1.locator('text=Alice')).toBeVisible();
    await expect(page1.locator('text=Invite Code')).toBeVisible();

    await ctx1.close();
    await ctx2.close();
  });

  test('spectator does not see "add yourself as a player" prompt', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Creator creates online match and adds self
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page1.click('button:has-text("Add")');

    const lobbyId = page1.url().split('/lobby/')[1];
    expect(lobbyId).toBeTruthy();

    // Spectator views lobby
    await page2.goto(`/spectate/${lobbyId}`);
    await page2.waitForTimeout(1000);
    await expect(spectatorLabel(page2)).toBeVisible({ timeout: 5000 });

    // Should NOT see "Add yourself as a player" prompt
    await expect(page2.locator('text=Add yourself as a player to get started')).not.toBeVisible({ timeout: 3000 });
    // Should NOT see "Waiting for opponent to join..."
    await expect(page2.locator('text=Waiting for opponent to join...')).not.toBeVisible({ timeout: 3000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('spectator can rejoin lobby after leaving', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Creator creates online match and adds self
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page1.click('button:has-text("Add")');

    const inviteCodeEl = page1.locator('text=Invite Code').locator('..').locator('code');
    const inviteCode = await inviteCodeEl.textContent();
    expect(inviteCode).toBeTruthy();

    const lobbyId = page1.url().split('/lobby/')[1];

    // Spectator views lobby
    await page2.goto(`/spectate/${lobbyId}`);
    await page2.waitForTimeout(1000);
    await expect(spectatorLabel(page2)).toBeVisible({ timeout: 5000 });

    // Spectator leaves
    await page2.click('text=Leave');
    await page2.waitForURL('/');
    await expect(page2.getByRole('heading', { name: 'InstaDarts' })).toBeVisible({ timeout: 5000 });

    // Spectator tries to join same lobby via invite code — should not hang
    await page2.click('text=Join Online Match');
    await page2.getByRole('textbox', { name: 'Invite code', exact: true }).fill(inviteCode!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);

    // Should reach the lobby (not stuck on "Joining lobby...")
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('the invite code gives way to "Lobby is full" as soon as the roster fills', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Creator creates online match and adds self
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page1.click('button:has-text("Add")');

    const inviteCodeEl = page1.locator('text=Invite Code').locator('..').locator('code');
    const inviteCode = await inviteCodeEl.textContent();
    expect(inviteCode).toBeTruthy();

    // Invite code should be visible before anyone joins
    await expect(page1.locator('text=Invite Code')).toBeVisible();

    // Joiner joins the lobby (does NOT add a player yet)
    await page2.goto('/');
    await page2.waitForTimeout(1000);
    await page2.click('text=Join Online Match');
    await page2.getByRole('textbox', { name: 'Invite code', exact: true }).fill(inviteCode!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    // A second user is not a full lobby any more — five players fit, so the code is still worth
    // showing and still shown.
    await expect(page1.locator('text=Invite Code')).toBeVisible({ timeout: 5000 });
    await expect(page1.locator('text=✓ 1 other user connected')).toBeVisible({ timeout: 5000 });

    // Joiner now adds themselves
    await page2.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
    await page2.click('button:has-text("Add")');
    await expect(page2.getByText('Bob', { exact: true })).toBeVisible();

    // The host fills the rest of the roster, and only then does the code go away — there is
    // nothing left for it to buy.
    for (const name of ['Carol', 'Dave', 'Eve']) {
      await page1.getByRole('textbox', { name: 'New player', exact: true }).fill(name);
      await page1.click('button:has-text("Add")');
    }
    await expect(page1.locator('text=✓ Lobby is full')).toBeVisible({ timeout: 5000 });
    await expect(page1.locator('text=Invite Code')).not.toBeVisible({ timeout: 3000 });

    await ctx1.close();
    await ctx2.close();
  });
});
