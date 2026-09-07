import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { VisitFixtureOptions } from './visitInputFixture';

async function render(page: Page, options: VisitFixtureOptions) {
  await page.evaluate((options) => window.renderVisitFixture(options), options);
  await expect(page.getByTestId('dart-evidence')).toHaveCount(options.count ?? 3);
}

async function geometry(page: Page) {
  return page.locator('.visit-input').evaluate((root) => {
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      direction: (root as HTMLElement).dataset.visitDirection,
      root: rect(root),
      footer: root.querySelector('[data-testid="visit-footer"]') ? rect(root.querySelector('[data-testid="visit-footer"]')!) : null,
      pairs: [...root.querySelectorAll('.visit-input__dart')].map((pair) => ({
        slot: rect(pair.querySelector('[data-visit-slot]')!),
        space: rect(pair.querySelector('[data-testid="visit-evidence-space"]')!),
        tile: rect(pair.querySelector('[data-testid="dart-evidence"]')!),
      })),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async (path) => { await import(/* @vite-ignore */ path); },
    `/@fs/${fileURLToPath(new URL('./visitInputFixture.tsx', import.meta.url))}`);
});

test('selects the larger squares and preserves alignment while resizing', async ({ page }) => {
  for (const [width, height, count, direction] of [
    [600, 300, 3, 'row'], [180, 760, 3, 'column'],
    [300, 600, 3, 'column'], [300, 400, 3, 'row'],
    [180, 760, 1, 'row'], [220, 1000, 6, 'column'], [750, 300, 6, 'row'],
  ] as const) {
    await render(page, { width, height, count });
    await expect(page.locator('.visit-input')).toHaveAttribute('data-visit-direction', direction);
    const layout = await geometry(page);
    const first = layout.pairs[0];
    for (const { slot, space, tile } of layout.pairs) {
      expect(Math.abs(tile.width - tile.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(tile.width - Math.min(slot.width, space.height))).toBeLessThanOrEqual(1);
      expect(Math.abs(tile.x + tile.width / 2 - slot.x - slot.width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(tile.y + tile.height / 2 - space.y - space.height / 2)).toBeLessThanOrEqual(1);
      expect(tile.y).toBeGreaterThan(slot.y + slot.height);
      expect(Math.abs((direction === 'row' ? slot.y : slot.x) - (direction === 'row' ? first.slot.y : first.slot.x))).toBeLessThanOrEqual(1);
      expect(Math.abs(tile.width - first.tile.width)).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(first.slot.y - layout.root.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.footer!.y + layout.footer!.height - layout.root.y - layout.root.height)).toBeLessThanOrEqual(1);
  }
});

test('remeasures wrapped labels and footer changes without oscillating', async ({ page }) => {
  const slots = ['A long score label with several words', 'T20', 'BONUS'];
  await render(page, { width: 220, height: 700, slots });
  await expect(page.locator('.visit-input')).toHaveAttribute('data-visit-direction', 'column');
  let layout = await geometry(page);
  expect(layout.pairs[0].slot.height).toBeGreaterThan(40);
  expect(layout.pairs[0].slot.height).toBe(layout.pairs[1].slot.height);

  await render(page, { width: 300, height: 480, footer: true });
  await expect(page.locator('.visit-input')).toHaveAttribute('data-visit-direction', 'row');
  await render(page, { width: 300, height: 480, footer: false });
  await expect(page.locator('.visit-input')).toHaveAttribute('data-visit-direction', 'column');
  layout = await geometry(page);
  expect(layout.footer).toBeNull();
  await page.getByTestId('visit-fixture').evaluate((element) => { element.style.width = '600px'; element.style.height = '300px'; });
  await expect(page.locator('.visit-input')).toHaveAttribute('data-visit-direction', 'row');
  await page.getByTestId('visit-fixture').evaluate((element) => { element.style.width = '180px'; element.style.height = '760px'; });
  await expect(page.locator('.visit-input')).toHaveAttribute('data-visit-direction', 'column');
  const changes = await page.locator('.visit-input').evaluate(async (root) => {
    let changes = 0;
    const observer = new MutationObserver(() => { changes++; });
    observer.observe(root, { attributes: true, attributeFilter: ['data-visit-direction'] });
    for (let i = 0; i < 10; i++) await new Promise(requestAnimationFrame);
    observer.disconnect();
    return changes;
  });
  expect(changes).toBe(0);
});

test('renders unavailable, unthrown, pending and received evidence states', async ({ page }) => {
  await render(page, { evidence: null });
  await expect(page.getByRole('img', { name: /evidence unavailable/ })).toHaveCount(3);
  await expect(page.getByTestId('dart-evidence').getByRole('button')).toHaveCount(0);

  await render(page, { evidence: [], slots: ['·', '·', { text: 'BONUS', tone: 'warning' }] });
  await expect(page.getByRole('img', { name: /evidence unavailable/ })).toHaveCount(0);
  await expect(page.getByTestId('dart-evidence').locator('svg')).toHaveCount(0);

  await render(page, { evidence: [], thrown: 1 });
  await expect(page.getByRole('img', { name: 'Dart 1 evidence unavailable' })).toBeVisible();
  await expect(page.getByRole('img', { name: /evidence unavailable/ })).toHaveCount(1);

  const image = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="green"/></svg>';
  await render(page, { evidence: [image], thrown: 1 });
  await expect(page.getByRole('img', { name: /evidence unavailable/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dart 1 evidence', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Dart evidence' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('dart-evidence').locator('img')).toHaveCount(0);
  await expect(page.getByRole('img', { name: /evidence unavailable/ })).toHaveCount(0);
});

for (const scheme of ['dark', 'light'] as const) {
  test(`uses surface-colored crossed cameras in ${scheme} mode`, async ({ page }) => {
    await render(page, { scheme });
    const colors = await page.getByTestId('dart-evidence').first().evaluate((tile) => {
      const svg = tile.querySelector('svg')!;
      const fixture = document.querySelector('[data-testid="visit-fixture"]')!;
      const rect = svg.getBoundingClientRect();
      return {
        icon: getComputedStyle(svg).color,
        surface: getComputedStyle(fixture).backgroundColor,
        background: getComputedStyle(tile).backgroundColor,
        widthRatio: rect.width / tile.getBoundingClientRect().width,
        paths: svg.querySelectorAll('path').length,
      };
    });
    expect(colors.icon).toBe(colors.surface);
    expect(colors.icon).not.toBe(colors.background);
    expect(colors.widthRatio).toBeCloseTo(0.4, 2);
    expect(colors.paths).toBe(2);
    await expect(page.getByTestId('top-camera').locator('svg')).toHaveAttribute('width', '20');
    await expect(page.getByTestId('top-camera').locator('path')).toHaveCount(1);
  });
}
