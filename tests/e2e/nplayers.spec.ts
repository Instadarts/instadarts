import { test, expect, type Locator, type Page } from '@playwright/test';
import { clickT20, clickT19, clickD12, setSwitch, submitVisit, setupLocalMatch } from './appHelpers';

async function autoFitMetrics(card: Locator, text: string) {
  return card.getByText(text, { exact: true }).evaluate((line) => {
    const host = line.parentElement;
    const playerCard = line.closest<HTMLElement>('[data-player]');
    if (!host || !playerCard) throw new Error('auto-fit score is outside a player card');
    const footer = [...playerCard.querySelectorAll<HTMLElement>('*')]
      .find((element) => element.children.length === 0
        && /throwing|waiting|departed/.test(element.textContent ?? ''));
    if (!footer) throw new Error('player card has no status footer');

    const lineRect = line.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const cardRect = playerCard.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return {
      fontSize: Number.parseFloat(getComputedStyle(line).fontSize),
      lineInsideHost: lineRect.left >= hostRect.left - 1
        && lineRect.right <= hostRect.right + 1
        && lineRect.top >= hostRect.top - 1
        && lineRect.bottom <= hostRect.bottom + 1,
      centerDelta: Math.abs(
        (lineRect.top + lineRect.height / 2) - (hostRect.top + hostRect.height / 2),
      ),
      footerBottomGap: cardRect.bottom - footerRect.bottom,
    };
  });
}

async function resizeGridItemVertically(page: Page, id: string, deltaY: number) {
  const item = page.locator(`[data-grid-item="${id}"]`);
  await item.scrollIntoViewIfNeeded();
  const handle = item.locator('.react-resizable-handle-se');
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (!box) throw new Error(`resize handle for ${id} has no bounding box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + deltaY, { steps: 10 });
  await page.mouse.up();
}

test.describe('N-players matches', () => {
  test('3-player local match with Count-Up mode', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Local Match');

    // Switch to Count-Up
    const selector = page.getByLabel('Game');
    await selector.selectOption('count-up');

    // Add 3 players
    for (const name of ['Alice', 'Bob', 'Carol']) {
      await page.getByRole('textbox', { name: 'New player', exact: true }).fill(name);
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
      await page.getByRole('textbox', { name: 'New player', exact: true }).fill(name);
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

  test('a crowded roster keeps every card\'s contents inside it, on a screen that scales', async ({ page }) => {
    // Above 2000px the root font size steps up (index.css), and everything in a player card is
    // sized in rem — so on a big screen the type grows and the box has to grow with it. Four is the
    // roster that catches it: four cards at their minimum width are almost exactly the summary
    // column, so none of them grows, and WINNER is the widest word either screen draws.
    await page.setViewportSize({ width: 2560, height: 1440 });
    const names = ['Alice', 'Bob', 'Carol', 'Dave'];
    await setupLocalMatch(page, names, 501);

    // Measured, not asserted visible: text that spills out of its box is still visible to
    // Playwright, and at 1600px wide it spills into the card's padding and leaves no other trace.
    const spilling = () => page.evaluate(() => (
      ([...document.querySelectorAll('[data-player]')] as HTMLElement[]).flatMap((card) => [
        ...(card.scrollWidth > card.clientWidth + 1 ? [`${card.dataset.player}: the card itself`] : []),
        ...[...card.querySelectorAll('p')]
          .filter((line) => line.scrollWidth > line.getBoundingClientRect().width + 1)
          .map((line) => `${card.dataset.player}: "${line.textContent}"`),
      ])
    ));

    expect(await spilling(), 'score cards during the match').toEqual([]);

    // Alice takes it in three visits — 180, 180, then a 141 checkout — while the other three pass.
    for (const visit of [[clickT20, clickT20, clickT20], [clickT20, clickT20, clickT20], [clickT20, clickT19, clickD12]]) {
      for (const dart of visit) await dart(page);
      await submitVisit(page);
      if (visit[2] !== clickD12) for (let i = 1; i < names.length; i++) await submitVisit(page);
    }

    await expect(page.getByText('Alice wins!')).toBeVisible({ timeout: 10_000 });
    expect(await spilling(), 'verdict cards on the summary').toEqual([]);
  });

  test('mode-provided score text refits in both directions and leaves the status footer pinned', async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 900 });
    await setupLocalMatch(page, ['Alice'], 301);

    const alice = page.locator('[data-player="Alice"]');
    await expect.poll(async () => (await autoFitMetrics(alice, '301')).lineInsideHost).toBe(true);
    const compactScore = await autoFitMetrics(alice, '301');
    expect(compactScore.centerDelta).toBeLessThan(2);
    expect(compactScore.footerBottomGap).toBeLessThan(20);

    await page.getByRole('button', { name: 'Settings' }).click();
    await setSwitch(page.getByRole('menu', { name: 'Settings' })
      .getByRole('switch', { name: 'Edit Match Layout' }), true);
    await page.keyboard.press('Escape');
    await resizeGridItemVertically(page, 'scores', 160);
    await expect.poll(async () => (await autoFitMetrics(alice, '301')).fontSize)
      .toBeGreaterThan(compactScore.fontSize);

    // Alice leaves 121, then leaving exactly one produces the mode's wider score string instead of
    // a numeric score.
    await clickT20(page); await clickT20(page); await clickT20(page);
    await submitVisit(page);
    await clickT20(page); await clickT20(page);
    await expect(alice.getByText('Bust!', { exact: true })).toBeVisible();

    const expandedBust = await autoFitMetrics(alice, 'Bust!');
    expect(expandedBust.lineInsideHost).toBe(true);
    expect(expandedBust.centerDelta).toBeLessThan(2);
    expect(expandedBust.footerBottomGap).toBeLessThan(20);

    const expandedBoxHeight = (await page.locator('[data-grid-item="scores"]').boundingBox())!.height;
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menu', { name: 'Settings' }).getByText('Reset layout', { exact: true }).click();
    await expect.poll(async () => (await page.locator('[data-grid-item="scores"]').boundingBox())!.height)
      .toBeLessThan(expandedBoxHeight);
    await expect.poll(async () => (await autoFitMetrics(alice, 'Bust!')).fontSize)
      .toBeLessThan(expandedBust.fontSize);
    const compactBust = await autoFitMetrics(alice, 'Bust!');
    expect(compactBust.lineInsideHost).toBe(true);
    expect(compactBust.centerDelta).toBeLessThan(2);
    expect(compactBust.footerBottomGap).toBeLessThan(20);
  });

  test('5-player local Whac-A-Mole, played through to the finale', async ({ page }) => {
    // Whac-A-Mole counts turns rather than rounds, so five players share a run of twenty rather
    // than stretching one over five times the darts. Twenty is the shortest run on offer: four
    // turns each, and short enough to play out here.
    await page.goto('/');
    await page.click('text=Local Match');
    await page.getByLabel('Game').selectOption('whac-a-mole');
    // Exact, or it also matches "Dig time (turns)".
    await page.getByLabel('Turns', { exact: true }).selectOption('20');

    const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];
    for (const name of names) {
      await page.getByRole('textbox', { name: 'New player', exact: true }).fill(name);
      await page.click('button:has-text("Add")');
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }

    await page.click('text=Start Match');
    await page.waitForURL('**/match/**');

    // The mode's own HUD: a row per player, and a turn counter that counts turns.
    for (const name of names) await expect(page.locator(`[data-player="${name}"]`)).toBeVisible();
    await expect(page.getByText(/Turn\s*1\s*\/\s*20/)).toBeVisible();
    await expect(page.getByText('ppt', { exact: true })).toBeVisible();

    // Play the run out. Misses cost nothing, so the turn limit is what ends it.
    for (let turn = 0; turn < 20; turn++) await submitVisit(page);

    // The heading, not the mode's "GAME OVER — submit to finish" notice, which says it too.
    await expect(page.getByRole('heading', { name: 'GAME OVER' })).toBeVisible();
    await expect(page.getByText(/of 20 turns/)).toBeVisible();
    // Four turns each at four points a turn: the ceiling for these settings, computed on the
    // server and shown so the total means something on its own.
    await expect(page.getByText('0% of a perfect 80')).toBeVisible();
    await expect(page.getByTestId('wam-finale').getByText('ppt', { exact: true })).toBeVisible();

    // The finale is exactly the board square and is `overflow-hidden`, so at five players the
    // player list is what has to give. Measured rather than asserted visible: a clipped element
    // still reports itself visible to Playwright, so `toBeVisible` passes either way and would
    // have let this ship. Both ends have to sit inside the card.
    const finale = page.getByTestId('wam-finale');
    const card = (await finale.boundingBox())!;
    const parts = [
      page.getByRole('heading', { name: 'GAME OVER' }),
      page.getByText('Press Submit Visit to finish'),
      // And every player's row: a card that fits its own ends but scrolls its roster is still
      // hiding the result from three of the five people who just played for it.
      ...names.map((name) => finale.getByText(name, { exact: true })),
    ];
    for (const part of parts) {
      const box = (await part.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(card.y);
      expect(box.y + box.height).toBeLessThanOrEqual(card.y + card.height);
    }
  });

  test('three users get a match but no video mesh', async ({ browser }) => {
    // A third board is a topology the mesh was never built for, so the server creates no session at
    // all and the match simply plays on the virtual board. The client says nothing about it: there
    // is no feed to be missing, so there is nothing to explain. That the server withholds the
    // session is pinned on the wire in tests/unit/media.test.ts; what matters here is that three
    // users still get a working match out of it.
    const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
    const [host, second, third] = await Promise.all(contexts.map((ctx) => ctx.newPage()));

    await host.goto('/');
    await host.click('text=Online Match');
    await host.getByLabel('Game').selectOption('count-up');
    await host.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await host.click('button:has-text("Add")');

    const code = (await host.locator('code').textContent())!.trim();
    for (const [page, name] of [[second, 'Bob'], [third, 'Carol']] as const) {
      await page.goto(`/lobby/join/${code}`);
      await page.getByRole('textbox', { name: 'New player', exact: true }).fill(name);
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
      await expect(page.getByTestId('dartboard')).toBeVisible();
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
    await host.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await host.click('button:has-text("Add")');
    await host.getByRole('textbox', { name: 'New player', exact: true }).fill('Carol');
    await host.click('button:has-text("Add")');

    // Get invite code
    const code = (await host.locator('code').textContent())?.trim();
    expect(code).toBeTruthy();

    // Guest joins
    await guest.goto(`/lobby/join/${code}`);
    await guest.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
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
    await host.getByRole('button', { name: 'Leave', exact: true }).click();
    await host.waitForURL('/');

    // Guest should now see match finished with Bob as WINNER
    await expect(guest.locator('text=Bob wins!')).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });
});
