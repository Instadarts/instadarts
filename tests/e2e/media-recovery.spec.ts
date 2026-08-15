import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { skipOnboarding } from './appHelpers';

test.describe.configure({ mode: 'serial' });

async function pairScorer(browser: Browser, frontend: Page) {
  await frontend.getByRole('button', { name: 'Cameras' }).first().click();
  await frontend.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = (await frontend.locator('p.font-mono.tracking-\\[0\\.3em\\]').textContent())!.trim();
  const context = await browser.newContext();
  await skipOnboarding(context);
  const page = await context.newPage();
  await page.goto('/scorer?e2e=1');
  await page.getByPlaceholder('CODE').fill(code);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByTestId('scorer-status')).toHaveText('Ready — no match running');
  await page.getByPlaceholder('Name this device').fill('Recovery board');
  await page.getByPlaceholder('Name this device').blur();
  await frontend.getByRole('radio', { name: 'Board camera: Recovery board' }).check();
  await frontend.getByRole('button', { name: 'Cameras' }).first().click();
  return { context, page };
}

async function setup(browser: Browser) {
  const alice = await browser.newContext();
  const host = await alice.newPage();
  await host.goto('/?e2e=1');
  await host.getByText('Create Online Match').click();
  await host.getByPlaceholder('New player name').fill('Alice');
  await host.getByRole('button', { name: 'Add' }).click();
  const code = (await host.locator('text=Invite Code').locator('..').locator('code').textContent())!.trim();

  const bob = await browser.newContext();
  const guest = await bob.newPage();
  await guest.goto(`/lobby/join/${code}?e2e=1`);
  await guest.getByPlaceholder('New player name').fill('Bob');
  await guest.getByRole('button', { name: 'Add' }).click();
  await expect(host.getByText('Bob')).toBeVisible();
  const scorer = await pairScorer(browser, host);

  await host.getByRole('button', { name: /Start Match/i }).click();
  await host.waitForURL('**/match/**');
  await guest.waitForURL('**/match/**');
  await expect.poll(() => host.evaluate(() => (window as any).__media.session())).toMatchObject({ setupComplete: true });
  await expect.poll(() => scorer.page.evaluate(() => (window as any).__media.video().offer)).toBeTruthy();
  return { alice, bob, host, guest, scorer };
}

async function mediaIdentity(page: Page) {
  return page.evaluate(() => ({
    self: (window as any).__media.self(),
    session: (window as any).__media.session(),
    socket: {
      generation: (window as any).__ws.generation(),
      sessionId: (window as any).__ws.sessionId(),
    },
  }));
}

async function sourceFeed(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__media.video().offer.feedId);
}

test('reloads, socket replacements, and same-peer ICE faults respect match identities', async ({ browser }) => {
  const { alice, bob, host, guest, scorer } = await setup(browser);
  const initialHost = await mediaIdentity(host);
  const initialGuest = await mediaIdentity(guest);
  const initialFeed = await sourceFeed(scorer.page);

  // A page reload is a new frontend/socket incarnation in the same mesh. The source is unaffected,
  // and exact-recipient consent is asked again after the one-time setup overlay closes.
  await guest.reload();
  await expect.poll(() => guest.evaluate(() => performance.getEntriesByName(`media-setup:${location.pathname.split('/').at(-1)}`).length))
    .toBeGreaterThan(0);
  await expect.poll(() => mediaIdentity(guest)).toMatchObject({ socket: { generation: 1 } });
  const reloadedGuest = await mediaIdentity(guest);
  expect(reloadedGuest.self).not.toBe(initialGuest.self);
  expect(reloadedGuest.session.meshId).toBe(initialGuest.session.meshId);
  expect(await sourceFeed(scorer.page)).toBe(initialFeed);
  await expect(guest.getByTestId('media-setup-overlay')).toHaveCount(0, { timeout: 5000 });
  await expect(guest.getByRole('dialog', { name: 'Live board video' })).toBeVisible();
  await guest.getByRole('button', { name: 'Use virtual board' }).click();

  // Replacing only the WebSocket also creates a peer incarnation, but must not reopen the full-page
  // gate on this mounted match.
  await host.evaluate(() => (window as any).__ws.drop());
  await expect.poll(() => mediaIdentity(host), { timeout: 15_000 })
    .toMatchObject({ socket: { generation: initialHost.socket.generation + 1 } });
  const replacedHost = await mediaIdentity(host);
  expect(replacedHost.self).not.toBe(initialHost.self);
  expect(replacedHost.session.meshId).toBe(initialHost.session.meshId);
  await expect(host.getByTestId('media-setup-overlay')).toHaveCount(0);
  expect(await sourceFeed(scorer.page)).toBe(initialFeed);

  // A spectator enters as a recipient and reissues `spectate` exactly for the replacement socket.
  const audience: BrowserContext = await browser.newContext();
  const watcher = await audience.newPage();
  const matchId = host.url().split('/match/')[1].split('?')[0];
  await watcher.goto(`/spectate/${matchId}?e2e=1`);
  await expect.poll(() => watcher.evaluate(() => (window as any).__media.self())).toBeTruthy();
  const watcherBefore = await mediaIdentity(watcher);
  await expect(watcher.getByTestId('media-setup-overlay')).toHaveCount(0, { timeout: 5000 });
  await watcher.evaluate(() => (window as any).__ws.drop());
  await expect.poll(() => mediaIdentity(watcher), { timeout: 15_000 })
    .toMatchObject({ socket: { generation: watcherBefore.socket.generation + 1 } });
  expect((await mediaIdentity(watcher)).self).not.toBe(watcherBefore.self);
  await expect(watcher.getByTestId('media-setup-overlay')).toHaveCount(0);
  expect(await sourceFeed(scorer.page)).toBe(initialFeed);

  // `disconnected` is recoverable in place. A synthetic terminal failure restarts ICE only on the
  // impolite/original-offerer endpoint, without replacing match, mesh, or peer identities.
  const cameraAtGuest = await guest.evaluate(() => (window as any).__media.links().find((link: any) => link.kind === 'device'));
  const faultPage = cameraAtGuest.polite ? scorer.page : guest;
  const faultPeer = cameraAtGuest.polite ? reloadedGuest.self : cameraAtGuest.peerId;
  const beforeFault = await mediaIdentity(faultPage);
  await faultPage.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'disconnected'), faultPeer);
  await expect(faultPage.getByTestId('media-setup-overlay')).toHaveCount(0);
  expect(await mediaIdentity(faultPage)).toMatchObject({ self: beforeFault.self, session: beforeFault.session });
  await faultPage.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'failed'), faultPeer);
  await expect.poll(() => faultPage.evaluate((peerId) => (window as any).__media.stats(peerId), faultPeer), { timeout: 5000 })
    .toMatchObject({ iceRestarts: 1 });
  await faultPage.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'connected'), faultPeer);

  // Replacing the scorer socket is the source boundary: same paired device, fresh scorer peer,
  // source epoch and feed UUID. Recipients get a fresh offer while the mesh itself stays put.
  const scorerBefore = await mediaIdentity(scorer.page);
  await scorer.page.evaluate(() => (window as any).__ws.drop());
  await expect.poll(() => mediaIdentity(scorer.page), { timeout: 15_000 })
    .toMatchObject({ socket: { generation: scorerBefore.socket.generation + 1 } });
  expect((await mediaIdentity(scorer.page)).self).not.toBe(scorerBefore.self);
  await expect.poll(() => sourceFeed(scorer.page), { timeout: 15_000 }).not.toBe(initialFeed);
  expect((await mediaIdentity(scorer.page)).session.meshId).toBe(initialHost.session.meshId);

  await audience.close();
  await scorer.context.close();
  await alice.close();
  await bob.close();
});
