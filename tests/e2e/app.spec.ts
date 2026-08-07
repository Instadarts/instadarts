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
  await expect(page.locator('button:has-text("Submit Visit")')).toBeEnabled({ timeout: 5000 });
  await page.click('button:has-text("Submit Visit")');
  // Brief wait for the server to process and clear currentVisit
  await page.waitForTimeout(300);
}

/** Verify a dart label is visible in the current darts row. */
async function expectDartLabel(page: Page, label: string) {
  await expect(page.locator(`text=${label}`).first()).toBeVisible();
}

/** Verify visit total appears in history. */
async function expectVisitTotal(page: Page, total: number) {
  await expect(page.getByText(`= ${total}`).first()).toBeVisible();
}

/** Hand the board to Alice if it is not already hers. The rota decides who starts each leg. */
async function ensureAliceThrows(alice: Page, bob: Page) {
  const card = alice.locator('[data-player="Alice"]');
  await expect(card).toBeVisible();
  if ((await card.getAttribute('aria-current')) !== 'true') await submitVisit(bob);
}

/**
 * Alice wins one leg at 501 — 180, 180, then a 141 checkout — while Bob passes.
 *
 * `bob` is the page playing Bob: the same one in a local match, the opponent's in an online one.
 */
async function winLegAt501(alice: Page, bob: Page = alice) {
  await ensureAliceThrows(alice, bob);
  await clickT20(alice); await clickT20(alice); await clickT20(alice);   // 180 → 321
  await submitVisit(alice);
  await submitVisit(bob);
  await clickT20(alice); await clickT20(alice); await clickT20(alice);   // 180 → 141
  await submitVisit(alice);
  await submitVisit(bob);
  await clickT20(alice); await clickT19(alice); await clickD12(alice);   // 141 → checkout
  await submitVisit(alice);
}

/** Set a match-format field in the lobby, and wait for the server to confirm it. */
async function setFormat(page: Page, label: string, value: number) {
  const field = page.getByLabel(label);
  await field.fill(String(value));
  await expect(field).toHaveValue(String(value));
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
  await page.getByLabel('Starting Score').selectOption(String(startScore));
  // Uncheck double-in (default off), ensure double-out is checked
  const diCheckbox = page.locator('text=Double In').locator('..').locator('input[type="checkbox"]');
  const doCheckbox = page.locator('text=Double Out').locator('..').locator('input[type="checkbox"]');
  if (await diCheckbox.isChecked()) await diCheckbox.uncheck();
  if (!await doCheckbox.isChecked()) await doCheckbox.check();

  // Start match
  await page.click('text=Start Match');
  await page.waitForURL('**/match/**');
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

  test('invalid invite code redirects to home', async ({ page }) => {
    await page.goto('/lobby/join/DOESNOTEXIST');
    await page.waitForURL('/', { timeout: 10000 });
    await expect(page.locator('text=InstaDarts')).toBeVisible();
  });

  test('non-existent lobby redirects to home', async ({ page }) => {
    await page.goto('/lobby/nonexistent-id');
    await page.waitForURL('/', { timeout: 10000 });
    await expect(page.locator('text=InstaDarts')).toBeVisible();
  });

  test('non-existent match redirects to home', async ({ page }) => {
    await page.goto('/match/nonexistent-id');
    await page.waitForURL('/', { timeout: 10000 });
    await expect(page.locator('text=InstaDarts')).toBeVisible();
  });

  test('joining a full lobby redirects to home', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const ctx3 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    const page3 = await ctx3.newPage();

    // Creator creates online match and adds both players
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    const code = await page1.locator('text=Invite Code').locator('..').locator('code').textContent();
    expect(code).toBeTruthy();

    // Second player joins and adds themselves (fills the lobby)
    await page2.goto('/');
    await page2.waitForTimeout(1000);
    await page2.click('text=Join Online Match');
    await page2.fill('input[placeholder="Invite code"]', code!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });
    await page2.fill('input[placeholder="New player name"]', 'Bob');
    await page2.click('button:has-text("Add")');
    await expect(page1.locator('text=Bob')).toBeVisible({ timeout: 5000 });

    // Third player tries to join the full lobby
    await page3.goto(`/lobby/join/${code!.trim()}`);
    // Should redirect to home because lobby is full
    await page3.waitForURL('/', { timeout: 10000 });
    await expect(page3.locator('text=InstaDarts')).toBeVisible();

    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
  });

  test('only one joiner can connect to a lobby', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const ctx3 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    const page3 = await ctx3.newPage();

    // Creator creates online match and adds self
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    const code = await page1.locator('text=Invite Code').locator('..').locator('code').textContent();
    expect(code).toBeTruthy();

    // First joiner joins the lobby (does NOT add a player yet)
    await page2.goto('/');
    await page2.waitForTimeout(1000);
    await page2.click('text=Join Online Match');
    await page2.fill('input[placeholder="Invite code"]', code!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    // Creator should see opponent connected
    await expect(page1.locator('text=✓ Opponent connected')).toBeVisible({ timeout: 5000 });

    // Second joiner tries to join the same lobby — should be rejected
    await page3.goto(`/lobby/join/${code!.trim()}`);
    // Should redirect to home because a joiner is already connected
    await page3.waitForURL('/', { timeout: 10000 });
    await expect(page3.locator('text=InstaDarts')).toBeVisible();

    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
  });

  test('creator can swap player order', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Local Match');

    // Add two players
    await page.fill('input[placeholder="New player name"]', 'Alice');
    await page.click('button:has-text("Add")');
    await page.fill('input[placeholder="New player name"]', 'Bob');
    await page.click('button:has-text("Add")');

    // Verify swap button is visible
    await expect(page.locator('button:has-text("Swap order")')).toBeVisible();

    // Alice should be 1st
    const aliceRow = page.locator('text=Alice').locator('..');
    await expect(aliceRow.locator('text=1st')).toBeVisible();

    // Click swap
    await page.click('button:has-text("Swap order")');

    // Now Bob should be 1st
    const bobRow = page.locator('text=Bob').locator('..');
    await expect(bobRow.locator('text=1st')).toBeVisible({ timeout: 3000 });

    // Swap back
    await page.click('button:has-text("Swap order")');
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

    // Match should be finished, Alice wins. The summary is the match's, not the leg's.
    await expect(page.locator('text=Alice wins!')).toBeVisible();
    await expect(page.locator('text=Match History')).toBeVisible();
    await expect(page.locator('text=Visit History')).toHaveCount(0);
  });

  test('overthrowing on a double reads as a bust, not a checkout', async ({ page }) => {
    await setupLocalMatch(page, ['Alice'], 301);

    // 301 − 180 leaves 121.
    await clickT20(page);
    await clickT20(page);
    await clickT20(page);
    await submitVisit(page);

    // 121 − 60 − 60 leaves 1, and D20 overthrows it to −39. The last dart being a double must not
    // make that read as a finish.
    await clickT20(page);
    await clickT20(page);
    await clickD20(page);

    await expect(page.locator('text=Bust!')).toBeVisible();
    await expect(page.locator('text=Checkout!')).toHaveCount(0);

    // And the server agrees once it is sent: a busted visit, and nobody has won.
    await submitVisit(page);
    await expect(page.locator('text=Alice wins!')).toHaveCount(0);
    await expect(page.locator('text=121')).toBeVisible();
  });

  test('leaving exactly one busts immediately under double out', async ({ page }) => {
    await setupLocalMatch(page, ['Alice'], 301);

    await clickT20(page);
    await clickT20(page);
    await clickT20(page);
    await submitVisit(page);

    // 121 − 60 − 60 = 1, which no double can check out. The visit is over there and then: the
    // third dart is not offered, and the player is told rather than left sitting on 1.
    await clickT20(page);
    await clickT20(page);
    await expect(page.locator('text=Bust!')).toBeVisible();

    await submitVisit(page);
    await expect(page.locator('text=T20 T20 = Bust')).toBeVisible();
    await expect(page.locator('text=121')).toBeVisible();
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
    const inviteCodeEl = page1.locator('text=Invite Code').locator('..').locator('code');
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

    // Page 1 starts the match (button should now be enabled with 2 players)
    await page1.waitForTimeout(500);
    await page1.click('button:has-text("Start Match")');
    await page1.waitForURL('**/match/**');
    await page2.waitForURL('**/match/**');

    // Both pages should see the match
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

test.describe('Lobby leave scenarios', () => {
  test('creator leaves → joiner sees lobby abandoned', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Creator creates online match and adds self
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    const code = await page1.locator('text=Invite Code').locator('..').locator('code').textContent();
    expect(code).toBeTruthy();

    // Joiner joins
    await page2.goto('/');
    await page2.waitForTimeout(1000);
    await page2.click('text=Join Online Match');
    await page2.fill('input[placeholder="Invite code"]', code!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    // Joiner adds themselves
    await page2.fill('input[placeholder="New player name"]', 'Bob');
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
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    const code = await page1.locator('text=Invite Code').locator('..').locator('code').textContent();
    expect(code).toBeTruthy();

    // Joiner joins
    await page2.goto('/');
    await page2.waitForTimeout(1000);
    await page2.click('text=Join Online Match');
    await page2.fill('input[placeholder="Invite code"]', code!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    // Joiner adds themselves
    await page2.fill('input[placeholder="New player name"]', 'Bob');
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
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    const code = await page1.locator('text=Invite Code').locator('..').locator('code').textContent();
    expect(code).toBeTruthy();

    // Joiner joins
    await page2.goto('/');
    await page2.waitForTimeout(1000);
    await page2.click('text=Join Online Match');
    await page2.fill('input[placeholder="Invite code"]', code!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    // Joiner adds themselves
    await page2.fill('input[placeholder="New player name"]', 'Bob');
    await page2.click('button:has-text("Add")');

    // Joiner leaves — should go to home
    await page2.click('text=Leave');
    await page2.waitForURL('/');
    await expect(page2.locator('text=InstaDarts')).toBeVisible({ timeout: 5000 });

    // Verify joiner STAYS on home (no stale lobby_state re-navigation)
    await page2.waitForTimeout(1500);
    await expect(page2.locator('text=InstaDarts')).toBeVisible();

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
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    const code = await page1.locator('text=Invite Code').locator('..').locator('code').textContent();
    expect(code).toBeTruthy();

    // Joiner joins
    await page2.goto('/');
    await page2.waitForTimeout(1000);
    await page2.click('text=Join Online Match');
    await page2.fill('input[placeholder="Invite code"]', code!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });
    await page2.fill('input[placeholder="New player name"]', 'Bob');
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
    await page1.click('button:has-text("Leave Match")');
    await page1.waitForURL('/');

    // Bob should be declared winner
    await expect(page2.locator('text=Bob wins!')).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });
});

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

    await expect(page2.locator('text=(spectating)')).toBeVisible({ timeout: 5000 });
    await expect(page2.locator('text=501').first()).toBeVisible();
    await expect(page2.locator('text=180').first()).toBeVisible();
    await expect(page2.locator('button:has-text("Submit Visit")')).not.toBeVisible({ timeout: 3000 });

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
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    const lobbyId = page1.url().split('/lobby/')[1];
    expect(lobbyId).toBeTruthy();

    await page2.goto(`/spectate/${lobbyId}`);
    await page2.waitForTimeout(1000);

    await expect(page2.locator('text=(spectating)')).toBeVisible({ timeout: 5000 });
    await expect(page2.locator('input[placeholder="New player name"]')).not.toBeVisible({ timeout: 3000 });
    await expect(page2.locator('button:has-text("Start Match")')).not.toBeVisible({ timeout: 3000 });
    await expect(page2.locator('text=(read-only)').first()).toBeVisible();
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
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    const lobbyId = page1.url().split('/lobby/')[1];

    await page2.goto(`/spectate/${lobbyId}`);
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=(spectating)')).toBeVisible({ timeout: 5000 });

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
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    const lobbyId = page1.url().split('/lobby/')[1];
    expect(lobbyId).toBeTruthy();

    // Spectator views lobby
    await page2.goto(`/spectate/${lobbyId}`);
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=(spectating)')).toBeVisible({ timeout: 5000 });

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
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');

    const inviteCodeEl = page1.locator('text=Invite Code').locator('..').locator('code');
    const inviteCode = await inviteCodeEl.textContent();
    expect(inviteCode).toBeTruthy();

    const lobbyId = page1.url().split('/lobby/')[1];

    // Spectator views lobby
    await page2.goto(`/spectate/${lobbyId}`);
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=(spectating)')).toBeVisible({ timeout: 5000 });

    // Spectator leaves
    await page2.click('text=Leave');
    await page2.waitForURL('/');
    await expect(page2.locator('text=InstaDarts')).toBeVisible({ timeout: 5000 });

    // Spectator tries to join same lobby via invite code — should not hang
    await page2.click('text=Join Online Match');
    await page2.fill('input[placeholder="Invite code"]', inviteCode!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);

    // Should reach the lobby (not stuck on "Joining lobby...")
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('"Opponent connected" shows as soon as joiner enters lobby', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Creator creates online match and adds self
    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.fill('input[placeholder="New player name"]', 'Alice');
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
    await page2.fill('input[placeholder="Invite code"]', inviteCode!.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000);
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    // Creator should see "Opponent connected" instead of invite code
    await expect(page1.locator('text=✓ Opponent connected')).toBeVisible({ timeout: 5000 });
    await expect(page1.locator('text=Invite Code')).not.toBeVisible({ timeout: 3000 });

    // Joiner should see the "Add yourself" prompt (they haven't added a player yet)
    await expect(page2.locator('text=Add yourself as a player to get started')).toBeVisible({ timeout: 5000 });

    // Joiner now adds themselves
    await page2.fill('input[placeholder="New player name"]', 'Bob');
    await page2.click('button:has-text("Add")');
    await expect(page2.locator('text=Bob')).toBeVisible();

    // Creator still sees opponent connected
    await expect(page1.locator('text=✓ Opponent connected')).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });
});


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

    await expect(page.locator('text=Play again?')).toBeVisible();
    const yes = (name: string) => page.getByRole('button', { name: `${name}: accept re-match` });
    await yes('Alice').click();
    await expect(yes('Alice')).toHaveAttribute('aria-pressed', 'true');
    expect(page.url()).toBe(firstMatch); // one player is not enough

    await yes('Bob').click();
    await page.waitForURL((url) => url.href !== firstMatch);

    // A new match, from scratch, with Bob leading off.
    await expect(page.locator('text=Play again?')).toHaveCount(0);
    await expect(page.locator('text=Visit History').locator('..').locator('div.font-mono')).toHaveCount(0);
    await expect(page.locator('text=501').first()).toBeVisible();
    const cards = page.locator('p.text-sm.text-gray-400');
    await expect(cards.first()).toHaveText('Bob');
  });

  test('online: each user answers for their own player', async ({ browser }) => {
    const page1 = await (await browser.newContext()).newPage();
    const page2 = await (await browser.newContext()).newPage();

    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');
    const code = (await page1.locator('text=Invite Code').locator('..').locator('code').textContent())!;

    await page2.goto(`/lobby/join/${code.trim()}`);
    await page2.fill('input[placeholder="New player name"]', 'Bob');
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
    await expect(watcher.locator('text=Visit History').locator('..').locator('div.font-mono')).toHaveCount(0);
    await expect(watcher.locator('text=Submit Visit')).toHaveCount(0); // still read-only
  });

  test('a cancelled match says so, and offers no re-match', async ({ browser }) => {
    const host = await (await browser.newContext()).newPage();
    await setupLocalMatch(host, ['Alice', 'Bob'], 501);
    const matchId = host.url().split('/match/')[1];

    const watcher = await (await browser.newContext()).newPage();
    await watcher.goto(`/spectate/${matchId}`);
    await expect(watcher.locator('text=501 — Double Out')).toBeVisible();

    await host.click('button:has-text("Leave Match")');

    await expect(watcher.locator('text=Match cancelled')).toBeVisible({ timeout: 5000 });
    await expect(watcher.locator('text=wins!')).toHaveCount(0);
    await expect(watcher.locator('text=Play again?')).toHaveCount(0);
  });

  test('a player who leaves is out for good — the other wins, with no re-match', async ({ browser }) => {
    const page1 = await (await browser.newContext()).newPage();
    const page2 = await (await browser.newContext()).newPage();

    await page1.goto('/');
    await page1.click('text=Create Online Match');
    await page1.fill('input[placeholder="New player name"]', 'Alice');
    await page1.click('button:has-text("Add")');
    const code = (await page1.locator('text=Invite Code').locator('..').locator('code').textContent())!;

    await page2.goto(`/lobby/join/${code.trim()}`);
    await page2.fill('input[placeholder="New player name"]', 'Bob');
    await page2.click('button:has-text("Add")');
    await expect(page1.locator('text=Bob')).toBeVisible({ timeout: 5000 });
    await page1.click('text=Start Match');
    await page1.waitForURL('**/match/**');
    await page2.waitForURL('**/match/**');

    await page1.click('button:has-text("Leave Match")');

    await expect(page2.locator('text=Bob wins!')).toBeVisible({ timeout: 5000 });
    await expect(page2.locator('text=Play again?')).toHaveCount(0);
  });
});

test.describe('Sets and legs', () => {
  test('a match of three legs runs leg by leg, alternating the throw', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Local Match');
    for (const name of ['Alice', 'Bob']) {
      await page.fill('input[placeholder="New player name"]', name);
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
      await page.fill('input[placeholder="New player name"]', name);
      await page.click('button:has-text("Add")');
    }
    await setFormat(page, 'Sets to win the match', 2);
    await page.click('text=Start Match');
    await page.waitForURL('**/match/**');

    // One leg per set, so the cards count legs and never mention sets.
    await expect(page.locator('text=0L')).toHaveCount(2);
    await expect(page.locator('text=0S')).toHaveCount(0);

    await winLegAt501(page);
    await expect(page.locator('text=1L')).toBeVisible();
    await expect(page.locator('text=Alice wins!')).toHaveCount(0);

    await winLegAt501(page);
    await expect(page.locator('text=Alice wins!')).toBeVisible();
  });
});
