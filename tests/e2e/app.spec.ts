import { test, expect, type Page, type Locator } from '@playwright/test';

// ============================================================
// Helpers
// ============================================================

/**
 * Click a position on the dartboard SVG.
 * Board coords: [0, 1_000_000], y-up, center [500_000, 500_000].
 * SVG is y-down, so we flip: svgY = 1_000_000 - boardY.
 */
async function clickBoard(page: Page, boardX: number, boardY: number) {
  const svg = page.locator('svg').first();
  const box = await svg.boundingBox();
  if (!box) throw new Error('SVG bounding box not found');

  const px = box.width * (boardX / 1_000_000);
  const py = box.height * (1 - boardY / 1_000_000);

  await svg.click({ position: { x: px, y: py } });
}

/** Click DB (center). */
async function clickDB(page: Page) {
  await clickBoard(page, 500_000, 500_000);
}

/** Click SB (slightly right of center). */
async function clickSB(page: Page) {
  await clickBoard(page, 520_000, 500_000);
}

/** Click T20 (triple ring at top). */
async function clickT20(page: Page) {
  await clickBoard(page, 500_000, 726_000);
}

/** Click S20 (single area at top). */
async function clickS20(page: Page) {
  await clickBoard(page, 500_000, 600_000);
}

/** Click D20 (double ring at top). */
async function clickD20(page: Page) {
  await clickBoard(page, 500_000, 866_000);
}

/** Click T19 (triple 19, slightly clockwise from top). */
async function clickT19(page: Page) {
  // 19 is at 162° from top? Actually sector order: 20(0°),1(18°),18(36°),4(54°),13(72°),6(90°),10(108°),15(126°),2(144°),17(162°),3(180°),19(198°)
  // 19 is index 11: 11*18 = 198° from top. 
  // x = r * sin(198°), y = C + r * cos(198°)
  const r = 226_000; // triple ring midpoint
  const angle = 198 * Math.PI / 180;
  await clickBoard(page, Math.round(500_000 + r * Math.sin(angle)), Math.round(500_000 + r * Math.cos(angle)));
}

/** Click D12 (double 12). */
async function clickD12(page: Page) {
  // 12 is index 18: 18*18 = 324° from top → or -36°
  const r = 366_000; // double ring midpoint
  const angle = 324 * Math.PI / 180;
  await clickBoard(page, Math.round(500_000 + r * Math.sin(angle)), Math.round(500_000 + r * Math.cos(angle)));
}

/** Submit the current visit. */
async function submitVisit(page: Page) {
  await page.click('button:has-text("Submit Visit")');
}

/** Verify a dart label is visible in the current darts row. */
async function expectDartLabel(page: Page, label: string) {
  // Labels appear in the VisitInput component as e.g. "T20 (60)"
  await expect(page.locator(`text=${label}`).first()).toBeVisible();
}

/** Verify visit total appears in history. */
async function expectVisitTotal(page: Page, total: number) {
  await expect(page.locator(`text== ${total}`).first()).toBeVisible();
}

/** Start a local match with given player names and settings. */
async function setupLocalMatch(page: Page, players: string[], startScore = 501) {
  await page.goto('/');
  await page.click('text=Local Match');

  // Add players
  for (const name of players) {
    await page.fill('input[placeholder="New player name"]', name);
    await page.click('button:has-text("Add")');
    await expect(page.locator(`text=${name}`)).toBeVisible();
  }

  // Configure settings
  await page.selectOption('select', String(startScore));
  // Uncheck double-in (default off), ensure double-out is checked
  const diCheckbox = page.locator('text=Double In').locator('..').locator('input[type="checkbox"]');
  const doCheckbox = page.locator('text=Double Out').locator('..').locator('input[type="checkbox"]');
  if (await diCheckbox.isChecked()) await diCheckbox.uncheck();
  if (!await doCheckbox.isChecked()) await doCheckbox.check();

  // Start game
  await page.click('text=Start Game');
  await expect(page.locator(`text=${startScore}`).first()).toBeVisible();
}

// ============================================================
// Tests
// ============================================================

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
});

test.describe('Local 1-player x01 match', () => {
  test('complete 501 leg, no double-in, double-out', async ({ page }) => {
    await setupLocalMatch(page, ['Alice'], 501);

    // --- Visit 1: T20, T20, T20 = 180, remaining 321 ---
    await clickT20(page);
    await clickT20(page);
    await clickT20(page);
    await expectDartLabel(page, 'T20');
    await submitVisit(page);
    await expectVisitTotal(page, 180);

    // --- Visit 2: T20, T20, T20 = 180, remaining 141 ---
    await clickT20(page);
    await clickT20(page);
    await clickT20(page);
    await submitVisit(page);
    await expectVisitTotal(page, 180);

    // --- Visit 3: T20, T19, D12 = 60+57+24 = 141, checkout! ---
    await clickT20(page);
    await clickT19(page);
    await clickD12(page);
    await submitVisit(page);
    await expectVisitTotal(page, 141);

    // Game should be finished, Alice wins
    await expect(page.locator('text=Alice wins!')).toBeVisible();
  });
});

test.describe('Local 2-player x01 match', () => {
  test('complete 501 leg with two players', async ({ page }) => {
    await setupLocalMatch(page, ['Alice', 'Bob'], 501);

    // --- Alice: Visit 1: T20, T20, T20 = 180, remaining 321 ---
    await clickT20(page); await clickT20(page); await clickT20(page);
    await submitVisit(page);
    await expectVisitTotal(page, 180);

    // --- Bob: Visit 1: T20, T20, T20 = 180, remaining 321 ---
    await clickT20(page); await clickT20(page); await clickT20(page);
    await submitVisit(page);
    await expectVisitTotal(page, 180);

    // --- Alice: Visit 2: T20, T20, T20 = 180, remaining 141 ---
    await clickT20(page); await clickT20(page); await clickT20(page);
    await submitVisit(page);

    // --- Bob: Visit 2: T20, S20, miss = 80, remaining 241 ---
    await clickT20(page); await clickS20(page);
    await submitVisit(page);
    await expectVisitTotal(page, 80);

    // --- Alice: Visit 3: T20, T19, D12 = 141, checkout! ---
    await clickT20(page); await clickT19(page); await clickD12(page);
    await submitVisit(page);
    await expectVisitTotal(page, 141);

    await expect(page.locator('text=Alice wins!')).toBeVisible();
  });
});

test.describe('Online multiplayer match', () => {
  test('2-player match via invite code', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // --- Page 1: Create online match ---
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    // Read invite code
    const inviteCodeEl = page1.locator('text=Invite Code').locator('..').locator('p.text-3xl');
    const inviteCode = await inviteCodeEl.textContent();
    expect(inviteCode).toBeTruthy();
    if (!inviteCode) return;

    // --- Page 2: Join via invite code ---
    await page2.goto('/');
    await page2.waitForTimeout(1000); // let WS connect and "Connecting..." disappear
    await page2.click('text=Join Online Match');
    await page2.fill('input[placeholder="Invite code"]', inviteCode.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000); // wait for WS response + React re-render

    // Page 2 should be in lobby (empty for them — needs to add themselves)
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    // Page 2 adds themselves as a player
    await page2.fill('input[placeholder="New player name"]', 'Bob');
    await page2.click('button:has-text("Add")');
    await expect(page2.locator('text=Bob')).toBeVisible();

    // Page 1 should now see Bob in the lobby
    await expect(page1.locator('text=Bob')).toBeVisible({ timeout: 5000 });

    // Configure settings: 501, no double-in, double-out
    const doCheckbox = page1.locator('text=Double Out').locator('..').locator('input[type="checkbox"]');
    if (!await doCheckbox.isChecked()) await doCheckbox.check();

    // Page 1 starts the game (button should now be enabled with 2 players)
    await page1.waitForTimeout(500);
    await expect(page1.locator('button:has-text("Start Game")')).toBeEnabled({ timeout: 5000 });
    await page1.click('button:has-text("Start Game")');

    // Both pages should see the game
    await expect(page1.locator('text=501').first()).toBeVisible();
    await expect(page2.locator('text=501').first()).toBeVisible();

    // --- Alice throws T20, T20, T20 = 180 ---
    await clickT20(page1); await clickT20(page1); await clickT20(page1);
    await submitVisit(page1);
    await expect(page1.locator('text=180').first()).toBeVisible();
    await expect(page2.locator('text=180').first()).toBeVisible();

    // --- Bob throws T20, T20, T20 = 180 ---
    await clickT20(page2); await clickT20(page2); await clickT20(page2);
    await submitVisit(page2);

    // Alice: T20, T20, T20 = 180 (now 141 remaining)
    await clickT20(page1); await clickT20(page1); await clickT20(page1);
    await submitVisit(page1);

    // Bob: T20, S20 = 80
    await clickT20(page2); await clickS20(page2);
    await submitVisit(page2);
    await expect(page2.locator('text=80').first()).toBeVisible();

    // Alice: T20, T19, D12 = 141 → checkout
    await clickT20(page1); await clickT19(page1); await clickD12(page1);
    await submitVisit(page1);

    // Both pages should see Alice wins
    await expect(page1.locator('text=Alice wins!')).toBeVisible({ timeout: 5000 });
    await expect(page2.locator('text=Alice wins!')).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });
});

