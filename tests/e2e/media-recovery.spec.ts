import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { skipOnboarding, winLegAt501 } from './appHelpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

interface OnlineRoom {
  alice: BrowserContext;
  bob: BrowserContext;
  host: Page;
  guest: Page;
}

interface RunningRoom extends OnlineRoom {
  scorer: { context: BrowserContext; page: Page };
}

async function onlineRoom(browser: Browser): Promise<OnlineRoom> {
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
  return { alice, bob, host, guest };
}

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

async function startRoom(browser: Browser): Promise<RunningRoom> {
  const room = await onlineRoom(browser);
  const scorer = await pairScorer(browser, room.host);
  await room.host.getByRole('button', { name: /Start Match/i }).click();
  await room.host.waitForURL('**/match/**');
  await room.guest.waitForURL('**/match/**');
  await expect.poll(() => room.host.evaluate(() => (window as any).__media.session()))
    .toMatchObject({ setupComplete: true });
  await expect.poll(() => sourceOffer(scorer.page)).toBeTruthy();
  return { ...room, scorer };
}

async function addSpectator(browser: Browser, matchId: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/spectate/${matchId}?e2e=1`);
  await expect.poll(() => page.evaluate(() => (window as any).__media.self())).toBeTruthy();
  return { context, page };
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

type MediaIdentity = Awaited<ReturnType<typeof mediaIdentity>>;

async function expectMediaSession(page: Page, matchId: string): Promise<void> {
  await expect.poll(async () => {
    const identity = await mediaIdentity(page);
    return { matchId: identity.session?.matchId ?? null, hasPeer: Boolean(identity.self) };
  }, { timeout: 15_000 }).toEqual({ matchId, hasPeer: true });
}

async function replacementIdentity(
  page: Page,
  before: MediaIdentity,
  generation: number,
): Promise<MediaIdentity> {
  await expect.poll(async () => {
    const current = await mediaIdentity(page);
    return {
      generation: current.socket.generation,
      socketReplaced: Boolean(current.socket.sessionId && current.socket.sessionId !== before.socket.sessionId),
      peerReplaced: Boolean(current.self && current.self !== before.self),
      matchId: current.session?.matchId ?? null,
      meshId: current.session?.meshId ?? null,
    };
  }, { timeout: 15_000 }).toEqual({
    generation,
    socketReplaced: true,
    peerReplaced: true,
    matchId: before.session.matchId,
    meshId: before.session.meshId,
  });
  return mediaIdentity(page);
}

async function sourceOffer(page: Page): Promise<{ feedId: string; accepted: string[] } | null> {
  return page.evaluate(() => (window as any).__media.video().offer);
}

async function sourceFeed(page: Page): Promise<string> {
  const offer = await sourceOffer(page);
  if (!offer) {
    const source = await page.evaluate(() => (window as any).__media.inbox().source);
    throw new Error(`scorer has no standing source offer; directives=${JSON.stringify(source)}`);
  }
  return offer.feedId;
}

async function acceptOffer(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Live board video' });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Show video' }).click();
}

async function expectAccepted(page: Page, peers: string[]): Promise<void> {
  await expect.poll(async () => [...((await sourceOffer(page))?.accepted ?? [])].sort())
    .toEqual([...peers].sort());
}

async function setupMarks(page: Page, matchId: string): Promise<{ starts: number[]; ends: number[] }> {
  return page.evaluate((id) => ({
    starts: performance.getEntriesByName(`media-setup-start:${id}`).map((entry) => entry.startTime),
    ends: performance.getEntriesByName(`media-setup-end:${id}`).map((entry) => entry.startTime),
  }), matchId);
}

async function expectSetupCompleted(page: Page, matchId: string): Promise<void> {
  await expect(page.getByTestId('media-setup-overlay')).toHaveCount(0, { timeout: 6500 });
  await expect.poll(async () => (await setupMarks(page, matchId)).starts.length).toBe(1);
  await expect.poll(async () => (await setupMarks(page, matchId)).ends.length).toBe(1);
}

async function replaceSocket(page: Page) {
  const before = await mediaIdentity(page);
  await page.evaluate(() => (window as any).__ws.drop());
  const after = await replacementIdentity(page, before, before.socket.generation + 1);
  return { before, after };
}

async function reloadPeer(page: Page) {
  const before = await mediaIdentity(page);
  await page.reload();
  const after = await replacementIdentity(page, before, 1);
  return { before, after };
}

async function closeRoom(room: RunningRoom, extra?: BrowserContext): Promise<void> {
  if (extra) await extra.close();
  await room.scorer.context.close();
  await room.alice.close();
  await room.bob.close();
}

test('the setup overlay settles, bypasses local opt-out, times out, and never gates in-place recovery', async ({ browser }) => {
  const room = await startRoom(browser);
  const matchId = room.host.url().split('/match/')[1].split('?')[0];
  await expectSetupCompleted(room.host, matchId);
  const marksBefore = await setupMarks(room.host, matchId);

  await replaceSocket(room.host);
  await expect(room.host.getByTestId('media-setup-overlay')).toHaveCount(0);
  expect(await setupMarks(room.host, matchId)).toEqual(marksBefore);
  const userLink = await room.host.evaluate(() => (window as any).__media.links().find((link: any) => link.kind === 'user'));
  await room.host.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'disconnected'), userLink.peerId);
  await expect(room.host.getByTestId('media-setup-overlay')).toHaveCount(0);
  expect(await setupMarks(room.host, matchId)).toEqual(marksBefore);
  await room.host.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'connected'), userLink.peerId);
  await closeRoom(room);

  const optedOut = await onlineRoom(browser);
  await optedOut.host.getByRole('button', { name: 'Cameras' }).first().click();
  await optedOut.host.getByRole('checkbox', { name: 'Share and watch live video during a match' }).uncheck();
  await optedOut.host.getByRole('button', { name: 'Cameras' }).first().click();
  await optedOut.host.getByRole('button', { name: /Start Match/i }).click();
  await optedOut.host.waitForURL('**/match/**');
  const optedOutId = optedOut.host.url().split('/match/')[1].split('?')[0];
  await expect(optedOut.host.getByTestId('media-setup-overlay')).toHaveCount(0);
  expect((await setupMarks(optedOut.host, optedOutId)).starts).toEqual([]);
  await optedOut.alice.close();
  await optedOut.bob.close();

  const timedOut = await onlineRoom(browser);
  await timedOut.guest.evaluate(() => sessionStorage.setItem('instadarts_e2e_hold_media_join', '1'));
  await timedOut.host.getByRole('button', { name: /Start Match/i }).click();
  await timedOut.host.waitForURL('**/match/**');
  await timedOut.guest.waitForURL('**/match/**');
  const timedOutId = timedOut.host.url().split('/match/')[1].split('?')[0];
  await expect.poll(() => timedOut.host.evaluate(() => (window as any).__media.session()))
    .toMatchObject({ setupComplete: false });
  await expectSetupCompleted(timedOut.host, timedOutId);
  const timeoutMarks = await setupMarks(timedOut.host, timedOutId);
  expect(timeoutMarks.ends[0] - timeoutMarks.starts[0]).toBeGreaterThanOrEqual(3900);
  expect(timeoutMarks.ends[0] - timeoutMarks.starts[0]).toBeLessThan(5500);
  await timedOut.guest.evaluate(() => window.dispatchEvent(new Event('instadarts:e2e-release-media-join')));
  await expect.poll(() => timedOut.host.evaluate(() => (window as any).__media.session()))
    .toMatchObject({ setupComplete: true });
  await expect(timedOut.host.getByTestId('media-setup-overlay')).toHaveCount(0);
  expect(await setupMarks(timedOut.host, timedOutId)).toEqual(timeoutMarks);
  await timedOut.alice.close();
  await timedOut.bob.close();
});

test('page reloads replace every endpoint with the required source and consent boundaries', async ({ browser }) => {
  const room = await startRoom(browser);
  const matchId = room.host.url().split('/match/')[1].split('?')[0];
  const watcher = await addSpectator(browser, matchId);
  await expectSetupCompleted(watcher.page, matchId);
  await acceptOffer(room.guest);
  await acceptOffer(watcher.page);

  const originalFeed = await sourceFeed(room.scorer.page);
  let guestId = (await mediaIdentity(room.guest)).self;
  let watcherId = (await mediaIdentity(watcher.page)).self;
  await expectAccepted(room.scorer.page, [guestId, watcherId]);

  const hostReload = await reloadPeer(room.host);
  await expectSetupCompleted(room.host, matchId);
  expect(hostReload.after.session.meshId).toBe(hostReload.before.session.meshId);
  expect(await sourceFeed(room.scorer.page)).toBe(originalFeed);
  await expectAccepted(room.scorer.page, [guestId, watcherId]);

  const guestReload = await reloadPeer(room.guest);
  await expectSetupCompleted(room.guest, matchId);
  expect(guestReload.after.session.meshId).toBe(guestReload.before.session.meshId);
  await expectAccepted(room.scorer.page, [watcherId]);
  expect(await sourceFeed(room.scorer.page)).toBe(originalFeed);
  await acceptOffer(room.guest);
  guestId = guestReload.after.self;
  await expectAccepted(room.scorer.page, [guestId, watcherId]);

  const watcherReload = await reloadPeer(watcher.page);
  await expectSetupCompleted(watcher.page, matchId);
  expect(watcherReload.after.session.meshId).toBe(watcherReload.before.session.meshId);
  await expectAccepted(room.scorer.page, [guestId]);
  expect(await sourceFeed(room.scorer.page)).toBe(originalFeed);
  await acceptOffer(watcher.page);
  watcherId = watcherReload.after.self;
  await expectAccepted(room.scorer.page, [guestId, watcherId]);

  const scorerReload = await reloadPeer(room.scorer.page);
  expect(scorerReload.after.session.meshId).toBe(scorerReload.before.session.meshId);
  await expect.poll(() => sourceFeed(room.scorer.page), { timeout: 15_000 }).not.toBe(originalFeed);
  await expectAccepted(room.scorer.page, []);
  await expect(room.guest.getByRole('dialog', { name: 'Live board video' })).toBeVisible();
  await expect(watcher.page.getByRole('dialog', { name: 'Live board video' })).toBeVisible();

  await closeRoom(room, watcher.context);
});

test('replacement WebSockets cover participant, opponent, spectator, and scorer without reopening setup', async ({ browser }) => {
  const room = await startRoom(browser);
  const matchId = room.host.url().split('/match/')[1].split('?')[0];
  const watcher = await addSpectator(browser, matchId);
  await acceptOffer(room.guest);
  await acceptOffer(watcher.page);

  const originalFeed = await sourceFeed(room.scorer.page);
  let guestId = (await mediaIdentity(room.guest)).self;
  let watcherId = (await mediaIdentity(watcher.page)).self;
  await expectAccepted(room.scorer.page, [guestId, watcherId]);
  const marks = new Map<Page, { starts: number[]; ends: number[] }>();
  for (const page of [room.host, room.guest, watcher.page]) marks.set(page, await setupMarks(page, matchId));

  const hostReplacement = await replaceSocket(room.host);
  expect(hostReplacement.after.session.meshId).toBe(hostReplacement.before.session.meshId);
  expect(await sourceFeed(room.scorer.page)).toBe(originalFeed);
  await expectAccepted(room.scorer.page, [guestId, watcherId]);

  const guestReplacement = await replaceSocket(room.guest);
  expect(guestReplacement.after.session.meshId).toBe(guestReplacement.before.session.meshId);
  await expectAccepted(room.scorer.page, [watcherId]);
  await acceptOffer(room.guest);
  guestId = guestReplacement.after.self;
  await expectAccepted(room.scorer.page, [guestId, watcherId]);

  const watcherReplacement = await replaceSocket(watcher.page);
  expect(watcherReplacement.after.session.meshId).toBe(watcherReplacement.before.session.meshId);
  await expectAccepted(room.scorer.page, [guestId]);
  await acceptOffer(watcher.page);
  watcherId = watcherReplacement.after.self;
  await expectAccepted(room.scorer.page, [guestId, watcherId]);

  const scorerReplacement = await replaceSocket(room.scorer.page);
  expect(scorerReplacement.after.session.meshId).toBe(scorerReplacement.before.session.meshId);
  await expect.poll(() => sourceFeed(room.scorer.page), { timeout: 15_000 }).not.toBe(originalFeed);
  await expectAccepted(room.scorer.page, []);
  await expect(room.guest.getByRole('dialog', { name: 'Live board video' })).toBeVisible();
  await expect(watcher.page.getByRole('dialog', { name: 'Live board video' })).toBeVisible();

  for (const [page, before] of marks) {
    await expect(page.getByTestId('media-setup-overlay')).toHaveCount(0);
    expect(await setupMarks(page, matchId)).toEqual(before);
  }
  await closeRoom(room, watcher.context);
});

test('same-peer disconnected and failed states preserve identities and cancel further ICE retries', async ({ browser }) => {
  const room = await startRoom(browser);
  const matchId = room.host.url().split('/match/')[1].split('?')[0];
  const watcher = await addSpectator(browser, matchId);
  const actors = [room.host, room.guest, watcher.page, room.scorer.page];
  const originalFeed = await sourceFeed(room.scorer.page);

  for (const page of actors) {
    await expect.poll(() => page.evaluate(() =>
      (window as any).__media.links().some((candidate: any) => candidate.ready)), { timeout: 15_000 })
      .toBe(true);
    const before = await mediaIdentity(page);
    const link = await page.evaluate(() => (window as any).__media.links().find((candidate: any) => candidate.ready));
    expect(link, 'actor has no ready link to fault').toBeTruthy();
    await page.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'disconnected'), link.peerId);
    await expect.poll(() => page.evaluate((peerId) =>
      (window as any).__media.links().find((candidate: any) => candidate.peerId === peerId)?.state, link.peerId))
      .toBe('disconnected');
    expect(await mediaIdentity(page)).toMatchObject({ self: before.self, session: before.session });
    await expect(page.getByTestId('media-setup-overlay')).toHaveCount(0);

    await page.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'failed'), link.peerId);
    await page.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'connected'), link.peerId);
    expect(await mediaIdentity(page)).toMatchObject({ self: before.self, session: before.session });
  }

  const candidates = await Promise.all(actors.map(async (page) => ({
    page,
    link: await page.evaluate(() => (window as any).__media.links().find((candidate: any) => !candidate.polite && candidate.ready)),
  })));
  const originalOfferer = candidates.find((candidate) => candidate.link);
  expect(originalOfferer, 'no original offerer endpoint was observable').toBeTruthy();
  const { page: faultPage, link: faultLink } = originalOfferer!;
  const beforeRestarts = (await faultPage.evaluate((peerId) => (window as any).__media.stats(peerId), faultLink.peerId)).iceRestarts ?? 0;
  await faultPage.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'failed'), faultLink.peerId);
  await expect.poll(async () => {
    const stats = await faultPage.evaluate((peerId) => (window as any).__media.stats(peerId), faultLink.peerId);
    return stats.iceRestarts ?? 0;
  }, { timeout: 5000 }).toBe(beforeRestarts + 1);
  await faultPage.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'connected'), faultLink.peerId);
  await expect.poll(async () => {
    const stats = await faultPage.evaluate((peerId) => (window as any).__media.stats(peerId), faultLink.peerId);
    return {
      pending: stats.iceRestartPending ?? false,
      inFlight: stats.iceRestartInFlight ?? false,
    };
  }, { timeout: 10_000 }).toEqual({ pending: false, inFlight: false });
  const afterRecovery = await faultPage.evaluate((peerId) => (window as any).__media.stats(peerId), faultLink.peerId);
  expect(afterRecovery.iceRestarts).toBe(beforeRestarts + 1);
  expect(await sourceFeed(room.scorer.page)).toBe(originalFeed);

  await closeRoom(room, watcher.context);
});

test('a rematch destroys every media identity and requires fresh exact-feed consent', async ({ browser }) => {
  const room = await startRoom(browser);
  const firstMatchId = room.host.url().split('/match/')[1].split('?')[0];
  const watcher = await addSpectator(browser, firstMatchId);
  await acceptOffer(room.guest);
  await acceptOffer(watcher.page);
  const first = {
    host: await mediaIdentity(room.host),
    guest: await mediaIdentity(room.guest),
    watcher: await mediaIdentity(watcher.page),
    scorer: await mediaIdentity(room.scorer.page),
    feed: await sourceFeed(room.scorer.page),
  };

  await winLegAt501(room.host, room.guest);
  await expect(room.host.getByText('Alice wins!')).toBeVisible();
  await expect.poll(() => sourceOffer(room.scorer.page)).toBeNull();
  for (const page of [room.host, room.guest, watcher.page, room.scorer.page]) {
    await expect.poll(() => page.evaluate(() => (window as any).__media.links().length)).toBe(0);
  }

  await room.host.getByRole('button', { name: 'Alice: accept re-match' }).click();
  await room.guest.getByRole('button', { name: 'Bob: accept re-match' }).click();
  await room.host.waitForURL((url) => url.pathname.includes('/match/') && !url.pathname.endsWith(firstMatchId));
  await room.guest.waitForURL((url) => url.pathname.includes('/match/') && !url.pathname.endsWith(firstMatchId));
  await watcher.page.waitForURL((url) => url.pathname.includes('/spectate/') && !url.pathname.endsWith(firstMatchId));
  const secondMatchId = room.host.url().split('/match/')[1].split('?')[0];

  await Promise.all([
    expectMediaSession(room.host, secondMatchId),
    expectMediaSession(room.guest, secondMatchId),
    expectMediaSession(watcher.page, secondMatchId),
    expectMediaSession(room.scorer.page, secondMatchId),
  ]);
  await expect.poll(() => sourceOffer(room.scorer.page)).toBeTruthy();
  const second = {
    host: await mediaIdentity(room.host),
    guest: await mediaIdentity(room.guest),
    watcher: await mediaIdentity(watcher.page),
    scorer: await mediaIdentity(room.scorer.page),
    feed: await sourceFeed(room.scorer.page),
  };
  expect(second.host.session.meshId).not.toBe(first.host.session.meshId);
  expect(second.host.self).not.toBe(first.host.self);
  expect(second.guest.self).not.toBe(first.guest.self);
  expect(second.watcher.self).not.toBe(first.watcher.self);
  expect(second.scorer.self).not.toBe(first.scorer.self);
  expect(second.feed).not.toBe(first.feed);
  await expectAccepted(room.scorer.page, []);
  await expectSetupCompleted(room.host, secondMatchId);
  await expectSetupCompleted(room.guest, secondMatchId);
  await expectSetupCompleted(watcher.page, secondMatchId);
  await expect(room.guest.getByRole('dialog', { name: 'Live board video' })).toBeVisible();
  await expect(watcher.page.getByRole('dialog', { name: 'Live board video' })).toBeVisible();

  await closeRoom(room, watcher.context);
});

test('local shared-board recovery preserves same-peer consent and rebuilds on rematch', async ({ browser }) => {
  const local = await browser.newContext();
  const player = await local.newPage();
  await player.goto('/?e2e=1');
  await player.getByText('Local Match').click();
  for (const name of ['Alice', 'Bob']) {
    await player.getByPlaceholder('New player name').fill(name);
    await player.getByRole('button', { name: 'Add' }).click();
  }
  const scorer = await pairScorer(browser, player);
  await player.getByRole('button', { name: /Start Match/i }).click();
  await player.waitForURL('**/match/**');
  const firstMatchId = player.url().split('/match/')[1].split('?')[0];
  const watcher = await addSpectator(browser, firstMatchId);
  await acceptOffer(watcher.page);

  const firstPlayer = await mediaIdentity(player);
  const firstWatcher = await mediaIdentity(watcher.page);
  const firstScorer = await mediaIdentity(scorer.page);
  const firstFeed = await sourceFeed(scorer.page);
  await expectAccepted(scorer.page, [firstWatcher.self]);
  await expect(player.getByRole('dialog', { name: 'Live board video' })).toHaveCount(0);
  await expect(player.getByTestId('live-board-feed')).toHaveCount(0);

  const cameraAtWatcher = await watcher.page.evaluate(() =>
    (window as any).__media.links().find((candidate: any) => candidate.kind === 'device' && candidate.ready));
  const watcherAtCamera = await scorer.page.evaluate((peerId) =>
    (window as any).__media.links().find((candidate: any) => candidate.peerId === peerId && candidate.ready), firstWatcher.self);
  expect(cameraAtWatcher).toBeTruthy();
  expect(watcherAtCamera).toBeTruthy();
  await watcher.page.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'disconnected'), cameraAtWatcher.peerId);
  await scorer.page.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'disconnected'), firstWatcher.self);
  await expectAccepted(scorer.page, [firstWatcher.self]);
  expect((await sourceOffer(scorer.page))!.feedId).toBe(firstFeed);
  await expect.poll(() => watcher.page.evaluate(() => (window as any).__media.video().watching[0]?.choice))
    .toBe('accepted');
  await watcher.page.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'connected'), cameraAtWatcher.peerId);
  await scorer.page.evaluate((peerId) => (window as any).__media.setLinkState(peerId, 'connected'), firstWatcher.self);
  await expect(watcher.page.getByRole('dialog', { name: 'Live board video' })).toHaveCount(0);

  const replacedWatcher = await replaceSocket(watcher.page);
  expect(replacedWatcher.after.session.meshId).toBe(firstWatcher.session.meshId);
  expect(await sourceFeed(scorer.page)).toBe(firstFeed);
  await expectAccepted(scorer.page, []);
  await acceptOffer(watcher.page);
  await expectAccepted(scorer.page, [replacedWatcher.after.self]);

  await winLegAt501(player);
  await expect(player.getByText('Alice wins!')).toBeVisible();
  await player.getByRole('button', { name: 'Alice: accept re-match' }).click();
  await player.getByRole('button', { name: 'Bob: accept re-match' }).click();
  await player.waitForURL((url) => url.pathname.includes('/match/') && !url.pathname.endsWith(firstMatchId));
  const secondMatchId = player.url().split('/match/')[1].split('?')[0];
  await watcher.page.waitForURL((url) => url.pathname.includes('/spectate/') && url.pathname.endsWith(secondMatchId));
  await expect.poll(() => sourceOffer(scorer.page)).toBeTruthy();
  for (const page of [player, watcher.page, scorer.page]) {
    await expectMediaSession(page, secondMatchId);
  }

  const secondPlayer = await mediaIdentity(player);
  const secondWatcher = await mediaIdentity(watcher.page);
  const secondScorer = await mediaIdentity(scorer.page);
  expect(secondPlayer.session.meshId).not.toBe(firstPlayer.session.meshId);
  expect(secondPlayer.self).not.toBe(firstPlayer.self);
  expect(secondWatcher.self).not.toBe(replacedWatcher.after.self);
  expect(secondScorer.self).not.toBe(firstScorer.self);
  expect(await sourceFeed(scorer.page)).not.toBe(firstFeed);
  await expectAccepted(scorer.page, []);
  await expect(watcher.page.getByRole('dialog', { name: 'Live board video' })).toBeVisible();

  await watcher.context.close();
  await scorer.context.close();
  await local.close();
});
