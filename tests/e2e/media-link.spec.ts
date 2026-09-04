// Whether a peer connection can actually be made between each pair of devices that needs one.
//
// The unit tests own the rules — who may talk to whom, and what the relay refuses. Nothing there
// opens a socket to anybody. This is the other half: real browsers, real ICE, real datachannels,
// and the question the rules cannot answer, which is whether any of it connects.
//
// Four contexts, because that is the smallest arrangement that contains every pair the feature
// needs: two players and a scoring device each.
//
// Note `?e2e=1` on every URL. It is what installs `window.__media` — see lib/e2e.ts — and it does
// nothing at all in a shipped bundle.

import { test, expect, type Browser, type Page } from '@playwright/test';
import { pairingCode, renameScorerDevice, scoringDeviceControls, setSwitch, skipOnboarding } from './appHelpers';

// ============================================================
// Reaching into a page's mesh
// ============================================================

interface LinkView {
  peerId: string;
  kind: 'user' | 'device';
  playerId?: string;
  polite: boolean;
  send: boolean;
  recv: boolean;
  state: string;
  ready: boolean;
}

function links(page: Page): Promise<LinkView[]> {
  return page.evaluate(() => (window as any).__media?.links() ?? []);
}

function selfId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__media?.self() ?? null);
}

/** Wait until this page holds `count` connected links, and hand them back. */
async function connectedLinks(page: Page, count: number): Promise<LinkView[]> {
  await expect
    .poll(async () => (await links(page)).filter((l) => l.state === 'connected' && l.ready).length, {
      timeout: 20_000,
      message: `expected ${count} connected links`,
    })
    .toBe(count);
  return (await links(page)).filter((l) => l.state === 'connected' && l.ready);
}

/** Ping a peer and wait for the pong the far mesh sends back without being asked. */
async function roundTrip(page: Page, peerId: string, seq: number): Promise<void> {
  const sent = await page.evaluate(([id, n]) => (window as any).__media.ping(id, n), [peerId, seq] as const);
  expect(sent, `control channel to ${peerId} was not writable`).toBe(true);
  await expect
    .poll(async () => page.evaluate(([id, n]) => {
      const inbox = (window as any).__media.inbox();
      return inbox.control.some((m: any) => m.from === id && m.data?.kind === 'pong' && m.data?.seq === n);
    }, [peerId, seq] as const), { timeout: 10_000, message: 'no pong came back' })
    .toBe(true);
}

// ============================================================
// Setting the four of them up
// ============================================================

/**
 * A scoring device paired to this frontend, named, and nominated as its board camera.
 *
 * The nomination is not a formality — a device is offered to nobody until its owner picks it, which
 * is the second of the two gates. The phone's own willingness is the first, and `video` is its
 * default, so nothing has to be set on the device itself.
 */
async function pairScorer(browser: Browser, frontend: Page, name: string) {
  await frontend.getByRole('button', { name: 'Cameras' }).first().click();
  await frontend.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = (await pairingCode(frontend).textContent())!.trim();

  const context = await browser.newContext();
  await skipOnboarding(context);
  const page = await context.newPage();
  await page.goto('/scorer?e2e=1');
  await page.getByPlaceholder('CODE').fill(code);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByTestId('scorer-status')).toHaveText('Ready — no match running');

  await renameScorerDevice(page, name);

  await setSwitch(scoringDeviceControls(frontend, name).getByRole('switch', { name: 'Board camera' }), true);
  // Close the panel again so the next pairing starts from the same place.
  await frontend.getByRole('button', { name: 'Cameras' }).first().click();
  return { context, page };
}

/** An online lobby with a player each. Media remains absent until the caller starts the match. */
async function onlineLobby(browser: Browser) {
  const alice = await browser.newContext();
  const host = await alice.newPage();
  await host.goto('/?e2e=1');
  await host.getByRole('button', { name: 'Online Match', exact: true }).click();
  await host.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
  await host.click('button:has-text("Add")');
  const code = (await host.locator('text=Invite Code').locator('..').locator('code').textContent())!;

  const bob = await browser.newContext();
  const guest = await bob.newPage();
  await guest.goto(`/lobby/join/${code.trim()}?e2e=1`);
  await guest.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
  await guest.click('button:has-text("Add")');
  await expect(host.locator('text=Bob')).toBeVisible({ timeout: 5000 });

  return { alice, bob, host, guest };
}

// ============================================================
// Tests
// ============================================================

test.describe('media links', () => {
  // One scoring device, not two. It already sits in all three pairs the feature exists for, and the
  // only thing a second would add — that two boards are never paired with each other — is asserted
  // directly in tests/unit/media.test.ts. A scoring device page loads the detection model, and a
  // second one is real CPU taken from every spec running beside this one.
  test('every pair a match needs connects, and carries a round trip', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineLobby(browser);
    const cam = await pairScorer(browser, host, 'Alice board');
    await host.getByRole('button', { name: /Start Match/i }).click();

    // Each frontend faces the opponent and the board; the board faces both frontends.
    const hostLinks = await connectedLinks(host, 2);
    const guestLinks = await connectedLinks(guest, 2);
    const camLinks = await connectedLinks(cam.page, 2);

    expect(hostLinks.find((l) => l.kind === 'device')?.playerId).toBeTruthy();
    expect(guestLinks.find((l) => l.kind === 'device')?.playerId).toBeTruthy();
    expect(camLinks.every((l) => l.kind === 'user')).toBe(true);

    // The three pairs, each proved by a message going out and an answer coming back over the peer
    // connection rather than through the server.
    const guestId = (await selfId(guest))!;
    const camId = (await selfId(cam.page))!;

    await roundTrip(host, guestId, 1);   // frontend ↔ frontend
    await roundTrip(host, camId, 2);     // device → its own frontend
    await roundTrip(guest, camId, 3);    // device → the opponent's frontend

    // And the connection is peer-to-peer on this machine's own network, not relayed.
    const stats = await host.evaluate((id) => (window as any).__media.stats(id), guestId);
    expect(['host', 'srflx']).toContain(stats.localCandidateType);
    expect(stats.localCandidateType).not.toBe('relay');

    await alice.close();
    await bob.close();
    await cam.context.close();
  });

  test('a spectator may watch and may not be watched', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineLobby(browser);
    const cam = await pairScorer(browser, host, 'Alice board');

    const lobbyId = host.url().split('/lobby/')[1].split('?')[0].split('#')[0];
    const watching = await browser.newContext();
    const watcher = await watching.newPage();
    await watcher.goto(`/spectate/${lobbyId}?e2e=1`);
    await expect(watcher.getByText('Online Match').first()).toBeVisible();
    await host.getByRole('button', { name: /Start Match/i }).click();

    // Both players and the board: three links, and not one of them may receive from the spectator.
    const seen = await connectedLinks(watcher, 3);
    expect(seen.every((l) => l.send && !l.recv)).toBe(true);

    // The other way round, the players see the spectator as somebody who only ever watches.
    const watcherId = await selfId(watcher);
    const asSeenByHost = (await links(host)).find((l) => l.peerId === watcherId);
    expect(asSeenByHost).toBeDefined();
    expect(asSeenByHost!.send).toBe(false);
    expect(asSeenByHost!.recv).toBe(true);

    expect(guest.url()).toContain('/match/');
    await alice.close();
    await bob.close();
    await watching.close();
    await cam.context.close();
  });

  test('a link closes when the peer behind it leaves', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineLobby(browser);
    await host.getByRole('button', { name: /Start Match/i }).click();
    await connectedLinks(host, 1);

    await guest.click('button:has-text("Leave")');

    // No teardown message exists anywhere in this protocol. The roster arriving without the peer in
    // it is the whole mechanism, and this is it working.
    await expect.poll(async () => (await links(host)).length, { timeout: 10_000 }).toBe(0);

    await alice.close();
    await bob.close();
  });
});
