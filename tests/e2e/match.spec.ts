// Playing a match: darts landing, visits submitted, the turn passing, a leg won.

import { test, expect, type Page } from '@playwright/test';
import { clickT20, clickS20, clickD20, clickT19, clickD12, submitVisit, expectDartLabel, setupLocalMatch } from './appHelpers';
import { CENTER, RADII, SVG_SIZE } from '../../src/client/components/boardGeometry';

test.describe('Local 1-player x01 match', () => {
  test('hold and drag uses the zoomed dart tip as the scoring position', async ({ page }) => {
    await setupLocalMatch(page, ['Alice'], 501);

    const board = page.getByTestId('dartboard');
    await board.scrollIntoViewIfNeeded();
    const box = await board.boundingBox();
    if (!box) throw new Error('dartboard bounding box not found');
    await expect(board.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

    // Everything below is a pointer put at a place on the board, so first bring its current grid
    // position fully into view. Otherwise a valid responsive rearrangement can dispatch a point
    // near the bottom edge where the window is showing nothing.
    const viewport = page.viewportSize()!;
    expect(box.y + box.height, 'the whole board must be in view to aim at it')
      .toBeLessThanOrEqual(viewport.height + 1); // fractional CSS pixels may straddle the edge

    /** A radius on the board's vertical axis, as a client y. The drawing is scaled to its box. */
    const above = (radius: number) => box.y + box.height * ((CENTER - radius) / SVG_SIZE);
    const below = (radius: number) => box.y + box.height * ((CENTER + radius) / SVG_SIZE);

    // Start an SVG unit below the inner edge of T20, in S20. There is enough physical and
    // coordinate space here for the full preferred 48px × 82px finger-to-tip offset.
    const x = box.x + box.width * 0.5;
    const y = above(RADII.tripleInner - 1);
    await page.mouse.move(x, y);
    await page.mouse.down();

    const dart = page.getByTestId('precision-dart');
    await expect(dart).toBeVisible({ timeout: 1_000 });
    await expect(dart).toHaveAttribute('data-score', 'S20');
    await expect(dart).toHaveAttribute('data-flight-color', '#363a41');
    await expect(board).not.toHaveAttribute('viewBox', '0 0 100 100');
    const offsetView = (await board.getAttribute('viewBox'))!.split(' ').map(Number);
    // What a pixel of finger travel is worth on the zoomed board. Every distance below is measured
    // through this rather than written down, because all of them depend on how many pixels of window
    // the board was given — which is a property of the screen the suite happens to run on.
    const pxPerUnitX = box.width / offsetView[2];
    const pxPerUnitY = box.height / offsetView[2];
    const heldX = Number(await dart.getAttribute('data-board-x')) / 10_000;
    const heldY = 100 - Number(await dart.getAttribute('data-board-y')) / 10_000;
    const tipClientX = box.x + ((heldX - offsetView[0]) / offsetView[2]) * box.width;
    const tipClientY = box.y + ((heldY - offsetView[1]) / offsetView[2]) * box.height;
    // Within a board unit of the preferred offset, not within a fixed number of decimal places:
    // `toBoard` rounds a dart to a whole unit — a ten-thousandth of an SVG unit — so the tip read
    // back out of the DOM cannot be more exact than that, and what that is worth in pixels is again
    // the board's size. What this guards against, a contracted offset, is out by whole pixels.
    expect(Math.abs(tipClientX - x - 48)).toBeLessThan(pxPerUnitX / 10_000);
    expect(Math.abs(tipClientY - y - 82)).toBeLessThan(pxPerUnitY / 10_000);

    // Up into the middle of the thin triple bed, from wherever the dart actually is: far enough to
    // enter it, never far enough to jump through. At 1280×720 that is some 24px, and half of it on
    // a screen that draws the board twice the size. The UI's live label and the submitted slot must
    // agree.
    const tripleMiddle = (RADII.tripleInner + RADII.tripleOuter) / 2;
    await page.mouse.move(x, y - (tripleMiddle - (CENTER - heldY)) * pxPerUnitY);
    await expect(dart).toHaveAttribute('data-score', 'T20');
    await expect(dart).toHaveAttribute('data-flight-color', '#ff335f');
    expect(await dart.locator('[data-flight-surface]').evaluateAll((flights) => (
      flights.map((flight) => flight.getAttribute('fill'))
    ))).toEqual(['#ff335f', '#ff335f']);
    expect(await dart.locator('[data-dart-outline]').evaluateAll((parts) => (
      parts.map((part) => part.getAttribute('stroke'))
    ))).toEqual(['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff']);
    await page.mouse.up();

    await expect(dart).toHaveCount(0);
    await expect(board).toHaveAttribute('viewBox', '0 0 100 100');
    await expectDartLabel(page, 'T20');

    // At D3 on an ordinary window, adding the full vertical offset would cross the visible SVG edge.
    // Only that component contracts, keeping the tip visibly inside the zoom.
    const doubleThreePointerY = below((RADII.doubleInner + RADII.doubleOuter) / 2);
    await page.mouse.move(box.x + box.width * 0.5, doubleThreePointerY);
    await page.mouse.down();
    await expect(dart).toBeVisible({ timeout: 1_000 });
    await expect(dart).toHaveAttribute('data-score', 'D3');
    const boundaryView = (await board.getAttribute('viewBox'))!.split(' ').map(Number);
    const doubleThreeY = 100 - Number(await dart.getAttribute('data-board-y')) / 10_000;
    expect(doubleThreeY).toBeGreaterThanOrEqual(boundaryView[1]);
    expect(doubleThreeY).toBeLessThanOrEqual(boundaryView[1] + boundaryView[2]);
    const doubleThreeClientY = box.y
      + ((doubleThreeY - boundaryView[1]) / boundaryView[2]) * box.height;
    expect(doubleThreeClientY).toBeLessThan(box.y + box.height);
    // The rule the tip follows: 82px below the finger, unless that would put it within 48px of the
    // bottom of what can be seen, in which case it sits on that limit and the offset is whatever is
    // left. Which of the two binds is a question about how many pixels tall the board is — at
    // 1280×720 the limit does and the offset contracts, while a screen that draws the board a
    // thousand pixels tall simply gives the dart its preferred 82px — so the test works out which
    // to expect instead of pinning the one it saw on the screen it was written on.
    const visibleBottom = Math.min(
      box.y + box.height,
      await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight),
    );
    const expectedTipY = Math.min(doubleThreePointerY + 82, visibleBottom - 48);
    expect(Math.abs(doubleThreeClientY - expectedTipY))
      .toBeLessThan(box.height / boundaryView[2] / 10_000);
    await page.mouse.up();

    // Outside the circular board is a miss: every flight switches to orange, never scoring red.
    await page.mouse.move(box.x + 3, box.y + 3);
    await page.mouse.down();
    await expect(dart).toBeVisible({ timeout: 1_000 });
    await expect(dart).toHaveAttribute('data-score', 'miss');
    await expect(dart).toHaveAttribute('data-flight-color', '#ff9f1c');
    expect(await dart.locator('[data-flight-surface]').evaluateAll((flights) => (
      flights.map((flight) => flight.getAttribute('fill'))
    ))).toEqual(['#ff9f1c', '#ff9f1c']);
    await page.mouse.up();
  });

  test('complete 501 leg, no double-in, double-out', async ({ page }) => {
    await setupLocalMatch(page, ['Alice'], 501);

    // --- Visit 1: T20, T20, T20 = 180, remaining 321 ---
    await clickT20(page);
    await clickT20(page);
    await clickT20(page);
    await expectDartLabel(page, 'T20');
    await submitVisit(page);
    await expect(page.locator('[data-player="Alice"]').getByText('321', { exact: true })).toBeVisible();

    // --- Visit 2: T20, T20, T20 = 180, remaining 141 ---
    await clickT20(page);
    await clickT20(page);
    await clickT20(page);
    await submitVisit(page);
    await expect(page.locator('[data-player="Alice"]').getByText('141', { exact: true })).toBeVisible();

    // --- Visit 3: T20, T19, D12 = 60+57+24 = 141, checkout! ---
    await clickT20(page);
    await clickT19(page);
    await clickD12(page);
    await submitVisit(page);

    // Match should be finished, Alice wins. The summary is the match's, not the leg's.
    await expect(page.locator('text=Alice wins!')).toBeVisible();
    await expect(page.locator('text=Match History')).toBeVisible();
  });

  test('overthrowing on a double reads as a bust, not a checkout', async ({ page }) => {
    await setupLocalMatch(page, ['Alice'], 301);

    // 301 − 180 leaves 121.
    await clickT20(page);
    await clickT20(page);
    await clickT20(page);
    await submitVisit(page);

    // 121 − 60 − 57 leaves 4, and D20 overthrows it to −36. The last dart being a double must not
    // make that read as a finish.
    //
    // The third dart has to be reachable, which is the whole difficulty here: this used to leave 1
    // after two darts, and a double-out player left on 1 has already busted — `isVisitLocked` says
    // so and the board stops taking darts. The D20 was never thrown, the assertions below passed on
    // the bust that leaving 1 had already caused, and the case this test is named for went
    // untested. Nothing said so, because a press the board will not take is dropped in silence.
    await clickT20(page);
    await clickT19(page);
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
    await expect(page.getByText('Visit: 0')).toBeVisible();
    await expect(page.locator('text=121')).toBeVisible();
  });
});

test.describe('Local 2-player x01 match', () => {
  test('complete 501 leg with two players', async ({ page }) => {
    await setupLocalMatch(page, ['Alice', 'Bob'], 501);

    // --- Alice: Visit 1: T20, T20, T20 = 180, remaining 321 ---
    await clickT20(page); await clickT20(page); await clickT20(page);
    await submitVisit(page);
    await expect(page.locator('[data-player="Alice"]').getByText('321', { exact: true })).toBeVisible();

    // --- Bob: Visit 1: T20, T20, T20 = 180, remaining 321 ---
    await clickT20(page); await clickT20(page); await clickT20(page);
    await submitVisit(page);
    await expect(page.locator('[data-player="Bob"]').getByText('321', { exact: true })).toBeVisible();

    // --- Alice: Visit 2: T20, T20, T20 = 180, remaining 141 ---
    await clickT20(page); await clickT20(page); await clickT20(page);
    await submitVisit(page);

    // --- Bob: Visit 2: T20, S20, miss = 80, remaining 241 ---
    await clickT20(page); await clickS20(page);
    await submitVisit(page);
    await expect(page.locator('[data-player="Bob"]').getByText('241', { exact: true })).toBeVisible();

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
    await page1.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
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
    await page2.getByRole('textbox', { name: 'Invite code', exact: true }).fill(inviteCode.trim());
    await page2.click('button:has-text("Join Match")');
    await page2.waitForTimeout(1000); // wait for WS response + React re-render

    // Page 2 should be in lobby (empty for them — needs to add themselves)
    await expect(page2.locator('text=Online Match')).toBeVisible({ timeout: 10000 });

    // Page 2 adds themselves as a player
    await page2.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
    await page2.click('button:has-text("Add")');
    await expect(page2.locator('text=Bob')).toBeVisible();

    // Page 1 should now see Bob in the lobby
    await expect(page1.locator('text=Bob')).toBeVisible({ timeout: 5000 });

    // Configure settings: 501, no double-in, double-out
    const doCheckbox = page1.getByRole('checkbox', { name: 'Double Out' });
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
