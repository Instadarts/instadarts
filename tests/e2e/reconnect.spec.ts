// The line goes down mid-lobby and comes back.
//
// A frontend queues what it could not send and flushes that queue when the socket reopens, so a
// press made during a blip is not lost. What makes the queue work is the order it goes out in: the
// server reads a connection's lobby or match from the connection itself, and gameplay messages from
// a connection that has not yet redeemed its seat are dropped without a reply.
//
// `context.setOffline` is not the tool for this — Chromium leaves an established WebSocket alone —
// so the socket is closed from inside the page, through a constructor the test installs before the
// app loads. Blocking reconnects while the press is made keeps the window deterministic rather than
// racing the one-second backoff.

import { expect, test, type Page } from '@playwright/test';
import { clickT20 } from './appHelpers';

declare global {
  interface Window {
    __appSockets: WebSocket[];
    __blockSockets: boolean;
  }
}

async function watchSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__appSockets = [];
    window.__blockSockets = false;
    const Original = window.WebSocket;
    class Watched extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (!String(url).includes('/ws')) return;
        window.__appSockets.push(this);
        if (window.__blockSockets) this.close();
      }
    }
    window.WebSocket = Watched;
  });
}

test.describe('a connection that drops and comes back', () => {
  test('honours a press made while the line was down', async ({ page }) => {
    await watchSockets(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Local Match' }).click();
    await page.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Alice', { exact: true })).toBeVisible();

    // A seat has to exist to be redeemed, or this would exercise a first connection rather than a
    // resumed one and the ordering it depends on would never come up.
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('instadarts_reconnect')))
      .not.toBeNull();

    await page.evaluate(() => {
      window.__blockSockets = true;
      window.__appSockets.at(-1)?.close();
    });
    await expect
      .poll(() => page.evaluate(() => window.__appSockets.at(-1)?.readyState))
      .not.toBe(WebSocket.OPEN);

    await page.getByText('Start Match').click();
    // Nothing can have happened: the press is in the queue, not on the wire.
    expect(page.url()).not.toContain('/match/');

    await page.evaluate(() => { window.__blockSockets = false; });
    await page.waitForURL('**/match/**', { timeout: 20_000 });
    await expect(page.getByTestId('dartboard')).toBeVisible();

    // Seated, not merely connected: the resumed connection can still play.
    await clickT20(page);
    await expect(page.getByText('T20', { exact: true }).first()).toBeVisible();
  });
});
