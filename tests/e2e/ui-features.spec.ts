// UI capabilities introduced by the responsive-layout branch. These tests exercise our menu,
// persistence and layout-editor integration without asserting Mantine markup or canonical RGL
// coordinates.

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import {
  APP_ZOOM_STORAGE_KEYS,
  MAX_APP_ZOOM,
  MIN_APP_ZOOM,
} from '../../src/client/layout/appZoom';
import {
  LIVE_MATCH_LAYOUTS,
  MATCH_LAYOUT_STORAGE_KEY,
  SUMMARY_MATCH_LAYOUTS,
  type FrontendBreakpoint,
  type MatchLayoutProfile,
} from '../../src/client/layout/frontendLayout';
import {
  clickD12,
  clickT19,
  clickT20,
  pairingCode,
  setSwitch,
  setupLocalMatch,
  skipOnboarding,
  submitVisit,
} from './appHelpers';

const UI_STORAGE_KEYS = [
  APP_ZOOM_STORAGE_KEYS.frontend,
  APP_ZOOM_STORAGE_KEYS.scorer,
  MATCH_LAYOUT_STORAGE_KEY,
];

interface StoredGridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

type StoredProfile = Partial<Record<FrontendBreakpoint, StoredGridItem[]>>;

async function clearUiPreferences(page: Page): Promise<void> {
  await page.addInitScript(({ keys, marker }: { keys: string[]; marker: string }) => {
    try {
      if (sessionStorage.getItem(marker)) return;
      for (const key of keys) localStorage.removeItem(key);
      sessionStorage.setItem(marker, '1');
    } catch {
      // about:blank has no storage; the script runs again on the app origin.
    }
  }, { keys: UI_STORAGE_KEYS, marker: 'instadarts_e2e_ui_preferences_cleared' });
}

async function storedValue(page: Page, key: string): Promise<string | null> {
  return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

async function expectAppliedZoom(
  page: Page,
  target: 'frontend' | 'scorer',
  value: number,
): Promise<void> {
  const variable = `--instadarts-${target}-zoom`;
  await expect.poll(() => page.evaluate((name) => (
    document.documentElement.style.getPropertyValue(name)
  ), variable)).toBe(`${value}%`);
  expect(await storedValue(page, APP_ZOOM_STORAGE_KEYS[target])).toBe(String(value));
}

async function expectInsideViewport(page: Page, element: Locator): Promise<void> {
  const viewport = page.viewportSize();
  const box = await element.boundingBox();
  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

async function expectGridItemsDoNotOverlap(page: Page): Promise<void> {
  const boxes = await page.locator('[data-grid-item]').evaluateAll((items) => items.map((item) => {
    const rect = item.getBoundingClientRect();
    return {
      id: item.getAttribute('data-grid-item'),
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    };
  }));

  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) {
      const separated = box.right <= other.left + 1
        || other.right <= box.left + 1
        || box.bottom <= other.top + 1
        || other.bottom <= box.top + 1;
      expect(separated, `${box.id} overlaps ${other.id}`).toBe(true);
    }
  }
}

async function gridItemHeight(page: Page, id: string): Promise<number> {
  const box = await page.locator(`[data-grid-item="${id}"]`).boundingBox();
  if (!box) throw new Error(`grid item ${id} has no bounding box`);
  return box.height;
}

async function scrollableAncestor(element: Locator): Promise<{ clientHeight: number; scrollHeight: number } | null> {
  return element.evaluate((node) => {
    let parent = node.parentElement;
    while (parent) {
      const style = getComputedStyle(parent);
      if (parent.scrollHeight > parent.clientHeight + 1 && /(auto|scroll)/.test(style.overflowY)) {
        return { clientHeight: parent.clientHeight, scrollHeight: parent.scrollHeight };
      }
      parent = parent.parentElement;
    }
    return null;
  });
}

async function openFrontendSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const menu = page.getByRole('menu', { name: 'Settings' });
  await expect(menu).toBeVisible();
  return menu;
}

async function openCameraMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole('menu', { name: /^Cameras(?: · \d+)?$/ });
  if (!await menu.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: /^Cameras(?: · \d+)?$/ }).click();
  }
  await expect(menu).toBeVisible();
  return menu;
}

async function requestPairingCode(page: Page): Promise<string> {
  const cameraMenu = await openCameraMenu(page);
  await cameraMenu.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = pairingCode(page);
  await expect(code).toBeVisible();
  return (await code.textContent() ?? '').trim();
}

async function openPairedScorer(browser: Browser, code: string) {
  const context = await browser.newContext({ viewport: { width: 360, height: 320 } });
  await skipOnboarding(context);
  const page = await context.newPage();
  await clearUiPreferences(page);
  await page.goto('/scorer');
  await page.getByPlaceholder('CODE').fill(code);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByTestId('scorer-status')).toHaveText('Ready — no match running');
  return { context, page };
}

async function openScorerSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const menu = page.getByRole('menu', { name: 'Settings' });
  await expect(menu).toBeVisible();
  return menu;
}

async function storedProfile(page: Page, profile: MatchLayoutProfile): Promise<StoredProfile | null> {
  return page.evaluate(({ key, wantedProfile }) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw)?.profiles?.[wantedProfile] ?? null;
  }, { key: MATCH_LAYOUT_STORAGE_KEY, wantedProfile: profile });
}

async function storedItem(
  page: Page,
  profile: MatchLayoutProfile,
  breakpoint: FrontendBreakpoint,
  id: string,
): Promise<StoredGridItem | undefined> {
  return (await storedProfile(page, profile))?.[breakpoint]?.find((item) => item.i === id);
}

async function resizeGridItemUp(page: Page, id: string, pixels: number): Promise<void> {
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
  await page.mouse.move(x, y - pixels, { steps: 6 });
  await page.mouse.up();
}

async function dragGridItem(page: Page, id: string, deltaX: number, deltaY: number): Promise<void> {
  const item = page.locator(`[data-grid-item="${id}"]`);
  await item.scrollIntoViewIfNeeded();
  const handle = item.getByLabel('Drag box');
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (!box) throw new Error(`drag handle for ${id} has no bounding box`);

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y + deltaY, { steps: 10 });
  await page.mouse.up();
}

async function finishSinglePlayerMatch(page: Page): Promise<void> {
  await clickT20(page); await clickT20(page); await clickT20(page);
  await submitVisit(page);
  await clickT20(page); await clickT20(page); await clickT20(page);
  await submitVisit(page);
  await clickT20(page); await clickT19(page); await clickD12(page);
  await submitVisit(page);
  await expect(page.getByText('Alice wins!', { exact: false })).toBeVisible();
}

test.describe('responsive UI branch features', () => {
  test('document grids remeasure growing and shrinking lobby content at the active breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Local Match' }).click();
    await expect(page.locator('[data-grid-item="players"]')).toBeVisible();

    const emptyHeight = await gridItemHeight(page, 'players');

    for (const name of ['Alice', 'Bob', 'Carol', 'Dave']) {
      await page.getByRole('textbox', { name: 'New player', exact: true }).fill(name);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }

    await expect.poll(() => gridItemHeight(page, 'players'))
      .toBeGreaterThan(emptyHeight);
    const grownHeight = await gridItemHeight(page, 'players');
    await expectGridItemsDoNotOverlap(page);

    const players = page.locator('[data-grid-item="players"]');
    const playerCard = players.locator('.frontend-grid-box');
    const [itemBox, cardBox] = await Promise.all([players.boundingBox(), playerCard.boundingBox()]);
    expect(itemBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(itemBox!.y + itemBox!.height + 1);

    for (let remaining = 3; remaining >= 1; remaining -= 1) {
      await page.getByTitle('Remove player').first().click();
      await expect(page.getByTitle('Remove player')).toHaveCount(remaining);
    }

    await expect.poll(() => gridItemHeight(page, 'players'))
      .toBeLessThan(grownHeight);
    await expectGridItemsDoNotOverlap(page);
  });

  test('global menus remain usable on narrow screens and frontend zoom persists within its bounds', async ({ page }) => {
    await clearUiPreferences(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');

    const status = page.getByRole('status', { name: 'Connected' });
    await expect(status.getByText('Connected', { exact: true })).toBeVisible();

    let menu = await openFrontendSettings(page);
    await expect(menu.getByRole('menuitem', { name: 'Source code' }))
      .toHaveAttribute('href', 'https://github.com/Instadarts');
    await expect(menu.getByRole('switch', { name: 'Edit Match Layout' })).toHaveCount(0);
    await expect(menu.getByText('Reset layout', { exact: true })).toHaveCount(0);
    await expect(menu.getByText('100%', { exact: true })).toBeVisible();

    await menu.getByRole('button', { name: 'Decrease zoom' }).click();
    await expect(menu.getByText('95%', { exact: true })).toBeVisible();
    await expectAppliedZoom(page, 'frontend', 95);

    // Zoom is one frontend preference, not a value attached to the current RGL breakpoint.
    await page.setViewportSize({ width: 360, height: 240 });
    await page.reload();
    await expect(status).toBeVisible();
    await expect(status.getByText('Connected', { exact: true })).toBeHidden();
    menu = await openFrontendSettings(page);
    await expect(menu.getByText('95%', { exact: true })).toBeVisible();
    await expectInsideViewport(page, menu);

    // Seed one step below each edge so the UI, persistence and disabled states all take part in the
    // bounds check without clicking through twenty intermediate values.
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: APP_ZOOM_STORAGE_KEYS.frontend,
      value: String(MAX_APP_ZOOM - 5),
    });
    await page.reload();
    menu = await openFrontendSettings(page);
    await menu.getByRole('button', { name: 'Increase zoom' }).click();
    await expect(menu.getByText(`${MAX_APP_ZOOM}%`, { exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Increase zoom' })).toBeDisabled();
    await expectAppliedZoom(page, 'frontend', MAX_APP_ZOOM);

    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: APP_ZOOM_STORAGE_KEYS.frontend,
      value: String(MIN_APP_ZOOM + 5),
    });
    await page.reload();
    menu = await openFrontendSettings(page);
    await menu.getByRole('button', { name: 'Decrease zoom' }).click();
    await expect(menu.getByText(`${MIN_APP_ZOOM}%`, { exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Decrease zoom' })).toBeDisabled();
    await expectAppliedZoom(page, 'frontend', MIN_APP_ZOOM);

    await page.keyboard.press('Escape');
    const cameras = await openCameraMenu(page);
    await expect(cameras.getByRole('button', { name: 'Pair scoring device' })).toBeVisible();
    await expect(cameras.getByRole('switch', { name: 'Live video' })).toBeVisible();
    await expectInsideViewport(page, cameras);
  });

  test('the narrow scorer settings scroll, and scorer zoom survives reload and device setup reset', async ({ browser }) => {
    const frontendContext = await browser.newContext();
    const frontend = await frontendContext.newPage();
    await clearUiPreferences(frontend);
    await frontend.goto('/');
    const code = await requestPairingCode(frontend);
    const scorer = await openPairedScorer(browser, code);

    await frontend.setViewportSize({ width: 360, height: 240 });
    const cameras = await openCameraMenu(frontend);
    await expectInsideViewport(frontend, cameras);
    const device = cameras.getByRole('group', { name: /^Scoring device:/ });
    await device.scrollIntoViewIfNeeded();
    await expect(device).toBeVisible();
    const cameraScrollHost = await scrollableAncestor(device);
    expect(cameraScrollHost).not.toBeNull();
    expect(cameraScrollHost!.scrollHeight).toBeGreaterThan(cameraScrollHost!.clientHeight);

    let menu = await openScorerSettings(scorer.page);
    await expectInsideViewport(scorer.page, menu);
    await expect(menu.getByText('100%', { exact: true })).toBeVisible();
    await menu.getByRole('button', { name: 'Decrease zoom' }).click();
    await expectAppliedZoom(scorer.page, 'scorer', 95);
    expect(await storedValue(scorer.page, APP_ZOOM_STORAGE_KEYS.frontend)).toBeNull();

    await scorer.page.reload();
    menu = await openScorerSettings(scorer.page);
    await expect(menu.getByText('95%', { exact: true })).toBeVisible();

    // The action at the bottom is reachable inside the height-limited dropdown, rather than making
    // the document or header grow beyond the short phone viewport.
    const setUp = menu.getByRole('button', { name: 'Set up' });
    await setUp.scrollIntoViewIfNeeded();
    await expect(setUp).toBeVisible();
    const scrollHost = await scrollableAncestor(setUp);
    expect(scrollHost).not.toBeNull();
    expect(scrollHost!.scrollHeight).toBeGreaterThan(scrollHost!.clientHeight);

    // Setting the device up again resets vision choices, but app-level presentation remains a
    // separate preference and is applied on the onboarding reload too.
    await setUp.click();
    const confirmSetUp = menu.getByRole('button', { name: 'Set up' });
    await expect(menu.getByText('Re-measures this device.', { exact: false })).toBeVisible();
    await confirmSetUp.click();
    await expect(scorer.page.getByRole('button', { name: 'Settings' })).toHaveCount(0);
    await expectAppliedZoom(scorer.page, 'scorer', 95);

    await frontendContext.close();
    await scorer.context.close();
  });

  test('match edit mode persists handle drags while board and visit controls remain interactive', async ({ page }) => {
    await clearUiPreferences(page);
    await page.setViewportSize({ width: 1360, height: 900 });
    await setupLocalMatch(page, ['Alice'], 501);

    let menu = await openFrontendSettings(page);
    await setSwitch(menu.getByRole('switch', { name: 'Edit Match Layout' }), true);
    await page.keyboard.press('Escape');

    const canonicalVisit = LIVE_MATCH_LAYOUTS.lg!.find((item) => item.i === 'visit')!;
    const before = await storedItem(page, 'match-live', 'lg', 'visit') ?? canonicalVisit;
    const beforePosition = `${before.x},${before.y}`;
    await dragGridItem(page, 'visit', 180, 120);
    await expect.poll(async () => {
      const item = await storedItem(page, 'match-live', 'lg', 'visit');
      return item ? `${item.x},${item.y}` : beforePosition;
    }).not.toBe(beforePosition);
    const dragged = await storedItem(page, 'match-live', 'lg', 'visit');

    await page.reload();
    expect(await storedItem(page, 'match-live', 'lg', 'visit')).toMatchObject({
      x: dragged!.x,
      y: dragged!.y,
    });

    menu = await openFrontendSettings(page);
    await expect(menu.getByRole('switch', { name: 'Edit Match Layout' })).not.toBeChecked();
    await setSwitch(menu.getByRole('switch', { name: 'Edit Match Layout' }), true);
    await page.keyboard.press('Escape');

    const boardBefore = await storedItem(page, 'match-live', 'lg', 'board');
    await clickT20(page);
    await expect(page.getByText('Visit: 60', { exact: true })).toBeVisible();
    await submitVisit(page);
    await expect(page.locator('[data-player="Alice"]').getByText('441', { exact: true })).toBeVisible();
    expect(await storedItem(page, 'match-live', 'lg', 'board')).toMatchObject({
      x: boardBefore!.x,
      y: boardBefore!.y,
    });
  });

  test('match layouts persist by breakpoint and reset only the active live or summary profile', async ({ page }) => {
    await clearUiPreferences(page);
    await page.setViewportSize({ width: 1360, height: 900 });
    await setupLocalMatch(page, ['Alice'], 501);

    let menu = await openFrontendSettings(page);
    const edit = menu.getByRole('switch', { name: 'Edit Match Layout' });
    await expect(edit).not.toBeChecked();
    await expect(menu.getByText('lg', { exact: true })).toBeVisible();
    await setSwitch(edit, true);
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Drag box')).not.toHaveCount(0);

    const lgBefore = await storedItem(page, 'match-live', 'lg', 'visit')
      ?? LIVE_MATCH_LAYOUTS.lg!.find((item) => item.i === 'visit')!;
    await resizeGridItemUp(page, 'visit', 60);
    await expect.poll(async () => (await storedItem(page, 'match-live', 'lg', 'visit'))?.h)
      .toBeLessThan(lgBefore!.h);
    const liveLgHeight = (await storedItem(page, 'match-live', 'lg', 'visit'))!.h;

    // Edit mode follows the live profile across breakpoints, while RGL reports and stores a distinct
    // arrangement for the newly active breakpoint.
    await page.setViewportSize({ width: 900, height: 900 });
    menu = await openFrontendSettings(page);
    await expect(menu.getByText('sm', { exact: true })).toBeVisible();
    await expect(menu.getByRole('switch', { name: 'Edit Match Layout' })).toBeChecked();
    await page.keyboard.press('Escape');
    const smBefore = await storedItem(page, 'match-live', 'sm', 'visit')
      ?? LIVE_MATCH_LAYOUTS.sm!.find((item) => item.i === 'visit')!;
    await resizeGridItemUp(page, 'visit', 40);
    await expect.poll(async () => (await storedItem(page, 'match-live', 'sm', 'visit'))?.h)
      .toBeLessThan(smBefore!.h);
    expect((await storedItem(page, 'match-live', 'lg', 'visit'))?.h).toBe(liveLgHeight);

    await page.setViewportSize({ width: 1360, height: 900 });
    await page.reload();
    menu = await openFrontendSettings(page);
    await expect(menu.getByText('lg', { exact: true })).toBeVisible();
    await expect(menu.getByRole('switch', { name: 'Edit Match Layout' })).not.toBeChecked();
    await page.keyboard.press('Escape');
    const liveBeforeSummary = await storedProfile(page, 'match-live');
    await finishSinglePlayerMatch(page);

    // Moving from live to summary selects a distinct profile and makes edit mode transient again.
    menu = await openFrontendSettings(page);
    await expect(menu.getByText('lg', { exact: true })).toBeVisible();
    const summaryEdit = menu.getByRole('switch', { name: 'Edit Match Layout' });
    await expect(summaryEdit).not.toBeChecked();
    expect(await storedProfile(page, 'match-live')).toEqual(liveBeforeSummary);
    await setSwitch(summaryEdit, true);
    await page.keyboard.press('Escape');

    const summaryBefore = await storedItem(page, 'match-summary', 'lg', 'result')
      ?? SUMMARY_MATCH_LAYOUTS.lg!.find((item) => item.i === 'result')!;
    await resizeGridItemUp(page, 'result', 40);
    await expect.poll(async () => (await storedItem(page, 'match-summary', 'lg', 'result'))?.h)
      .toBeLessThan(summaryBefore!.h);
    const customSummaryHeight = (await storedItem(page, 'match-summary', 'lg', 'result'))!.h;
    expect(await storedProfile(page, 'match-live')).toEqual(liveBeforeSummary);

    menu = await openFrontendSettings(page);
    await menu.getByText('Reset layout', { exact: true }).click();
    await expect(page.getByLabel('Drag box')).toHaveCount(0);
    expect(await storedProfile(page, 'match-live')).toEqual(liveBeforeSummary);

    const canonicalSummaryHeight = SUMMARY_MATCH_LAYOUTS.lg!
      .find((item) => item.i === 'result')!.h;
    await expect.poll(async () => (
      (await storedItem(page, 'match-summary', 'lg', 'result'))?.h ?? canonicalSummaryHeight
    )).toBe(canonicalSummaryHeight);
    expect(canonicalSummaryHeight).not.toBe(customSummaryHeight);
  });
});
