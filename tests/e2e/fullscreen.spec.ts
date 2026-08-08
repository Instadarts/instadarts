import { test, expect, type Page } from '@playwright/test';

/**
 * The fullscreen toggle, on both apps.
 *
 * A match screen on a television and a phone mounted at a board both want the whole display, and
 * browser chrome is the last thing between them and having it. The button is the only way to ask —
 * the Fullscreen API needs a user gesture, so nothing can do this on the page's own initiative.
 *
 * There is no iPhone case to test here: Safari on iPhone has no element fullscreen at all, and the
 * button renders nothing there rather than throwing. That is a real-device check, recorded in
 * docs/vision.md.
 */

async function isFullscreen(page: Page): Promise<boolean> {
  return page.evaluate(() => document.fullscreenElement !== null);
}

test.describe('full screen', () => {
  test('the frontend toggles into it and back out', async ({ page }) => {
    await page.goto('/');

    const button = page.getByTestId('fullscreen');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-label', 'Full screen');

    await button.click();
    await expect(button).toHaveAttribute('aria-label', 'Leave full screen');
    expect(await isFullscreen(page)).toBe(true);

    await button.click();
    await expect(button).toHaveAttribute('aria-label', 'Full screen');
    expect(await isFullscreen(page)).toBe(false);
  });

  test('the label follows the browser, not the button', async ({ page }) => {
    // Android's back gesture and the Escape key both leave full screen without telling anyone, and
    // a button that has to be pressed twice afterwards is worse than no button.
    await page.goto('/');
    const button = page.getByTestId('fullscreen');

    await button.click();
    await expect(button).toHaveAttribute('aria-label', 'Leave full screen');

    await page.evaluate(() => document.exitFullscreen());

    await expect(button).toHaveAttribute('aria-label', 'Full screen');
  });

});

// The scoring device's own button is asserted in scorer-pairing.spec.ts, where a paired device
// already exists: it lives on the scoring screen rather than on the code entry screen, so there is
// nothing to press until a device has been paired.
