// How a match is configured before it starts: its format in sets and legs, and its game mode.

import { test, expect } from '@playwright/test';
import { clickT20, submitVisit, winLegAt501, setFormat, setupLocalMatch } from './appHelpers';

test.describe('Sets and legs', () => {
  test('a match of three legs runs leg by leg, alternating the throw', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Local Match');
    for (const name of ['Alice', 'Bob']) {
      await page.getByRole('textbox', { name: 'New player', exact: true }).fill(name);
      await page.click('button:has-text("Add")');
    }
    await setFormat(page, 'Legs to win a set', 3);
    await page.click('text=Start Match');
    await page.waitForURL('**/match/**');

    // Both start at nothing won, and Alice throws first.
    await expect(page.locator('text=0S | 0L')).toHaveCount(2);
    await expect(page.locator('text=▶ throwing')).toBeVisible();

    // Alice takes leg one. Bob then has the throw, so Alice must wait a visit for each of the rest.
    await winLegAt501(page);
    await expect(page.locator('text=0S | 1L')).toBeVisible();
    // A fresh leg: both back to the start. Exact, or the headline's "501 — Double Out" counts too.
    await expect(page.getByText('501', { exact: true })).toHaveCount(2);
    await expect(page.locator('text=Alice wins!')).toHaveCount(0); // one leg is not the match

    await winLegAt501(page);
    await expect(page.locator('text=0S | 2L')).toBeVisible();

    await winLegAt501(page);
    await expect(page.locator('text=Alice wins!')).toBeVisible();
  });

  test('single-leg sets are shown as legs', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Local Match');
    for (const name of ['Alice', 'Bob']) {
      await page.getByRole('textbox', { name: 'New player', exact: true }).fill(name);
      await page.click('button:has-text("Add")');
    }
    await setFormat(page, 'Sets to win the match', 2);
    await page.click('text=Start Match');
    await page.waitForURL('**/match/**');

    // One leg per set, so the cards count legs and never mention sets. Scoped to the cards and
    // anchored, because a bare `text=0S` matches any substring — the panel's "180s" among them.
    const standings = (name: string) => page.locator(`[data-player="${name}"]`).getByText(/^\d+[SL]$/);
    await expect(standings('Alice')).toHaveText('0L');
    await expect(standings('Bob')).toHaveText('0L');

    await winLegAt501(page);
    await expect(standings('Alice')).toHaveText('1L');
    await expect(page.locator('text=Alice wins!')).toHaveCount(0);

    await winLegAt501(page);
    await expect(page.locator('text=Alice wins!')).toBeVisible();
  });
});

test.describe('Game modes', () => {
  test('the lobby offers the modes the server has installed', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Local Match');

    // The selector, its settings block and its contents all come from the server. Modes are offered
    // in id order, which is not the order they were installed in and not where the default sits.
    const selector = page.getByLabel('Game');
    await expect(selector).toHaveValue('x01');
    await expect(selector.locator('option')).toHaveText(['Count-Up', 'Whac-A-Mole', 'x01']);
    await expect(page.locator('text=x01 settings')).toBeVisible();
    await expect(page.getByLabel('Starting Score')).toBeVisible();

    // Switching mode swaps the whole settings block for the one the other mode declares.
    await selector.selectOption('whac-a-mole');
    await expect(page.locator('text=Whac-A-Mole settings')).toBeVisible();
    await expect(page.getByLabel('Moles at once')).toBeVisible();
    await expect(page.getByLabel('Starting Score')).toHaveCount(0);
  });

  test("the mode's own panel shows statistics across the match", async ({ page }) => {
    await setupLocalMatch(page, ['Alice', 'Bob'], 501);

    // Up from the start, so the screen does not jump when the first dart lands. The panel has no
    // heading of its own, so what says it is there is what it always draws: the round, and a card
    // per player.
    await expect(page.locator('text=Round 1')).toBeVisible();
    await expect(page.locator('text=3-DART AVERAGE')).toHaveCount(2);

    await clickT20(page); await clickT20(page); await clickT20(page);
    await submitVisit(page);

    await expect(page.locator('text=Round 1')).toBeVisible();

    // x01 ships a component for its panel, so these read the rendered card rather than a table.
    // A maximum from 501 counts towards both averages, and cost Alice a full visit of darts.
    const cards = page.locator('text=3-DART AVERAGE').locator('../..');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('180.0');   // Alice
    await expect(cards.first()).toContainText('Scoring average');
    await expect(cards.first()).toContainText('180s');
    // Bob has not thrown, so he has no average to report rather than an average of nothing.
    await expect(cards.last()).toContainText('—');
  });
});
