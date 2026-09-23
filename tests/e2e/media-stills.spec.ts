// Dart evidence, end to end: a real board photo, a real inference, a real peer connection, and a
// real JPEG arriving on both sides of a match.
//
// Nothing here is stubbed after the camera. The device solves a homography from the photograph,
// inverts it to find the quarter of the board a dart landed in, crops its own frame and encodes it;
// the frontends decode what comes back. That whole chain is what makes it worth a heavy test — the
// arithmetic in it is exercised by tests/unit/still.test.ts, but whether the pieces fit together is
// only answerable here.
//
// Lives in the `heavy` project because it drives a model, and that is the load that starves a
// scoring device's page into missing a heartbeat — which fails `scorer-power`, not this file. The
// project ordering and the reasoning are in playwright.config.ts.

import { test, expect, type Page, type Browser } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { installFakeCamera, scan, showScene } from './fakeCamera';
import { CONFIG_DEFAULTS } from '../../src/shared/config';
import {
  clickT20, closeScorerSettings, pairingCode, renameScorerDevice, scoringDeviceControls, setSwitch, skipOnboarding,
  startScorerCamera,
} from './appHelpers';

const SCENES = {
  // Camera startup now performs a real cold inference. Begin where the test's prose always said it
  // began — a mounted, empty board — so the later switch to darts is the throw being photographed,
  // not three darts that were already present when the camera came online.
  empty: fileURLToPath(new URL('../media/board-empty.jpg', import.meta.url)),
  darts: fileURLToPath(new URL('../media/board-three-darts.jpg', import.meta.url)),
};

/** Loading a 2.4MB model and running it is slower than clicking a button. */
test.setTimeout(120_000);

async function openScorer(browser: Browser) {
  const context = await browser.newContext({ permissions: ['camera'] });
  await skipOnboarding(context);
  const page = await context.newPage();
  await installFakeCamera(page, SCENES);
  await page.goto('/scorer?e2e=1');
  return { context, page };
}

/** Pair this phone to that frontend, leaving the camera menu open on it. */
async function pair(player: Page, scorer: Page, name: string) {
  await player.getByRole('button', { name: 'Cameras' }).first().click();
  await player.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = (await pairingCode(player).textContent())!.trim();

  await scorer.getByPlaceholder('CODE').fill(code);
  await scorer.getByRole('button', { name: 'Pair' }).click();
  await renameScorerDevice(scorer, name);
}

/** Pair this phone to that frontend and nominate it as the board camera. */
async function pairAndNominate(player: Page, scorer: Page, name: string) {
  await pair(player, scorer, name);
  await setSwitch(scoringDeviceControls(player, name).getByRole('switch', { name: 'Board camera' }), true);
  await player.getByRole('button', { name: 'Cameras' }).first().click();
}

/**
 * How much this phone shares, set through its own settings — the phone's answer, which its owner
 * cannot give for it.
 */
async function shareFromScorer(scorer: Page, tier: 'disabled' | 'stills' | 'video') {
  await scorer.getByRole('button', { name: 'Settings' }).click();
  await scorer.getByRole('combobox', { name: 'Share this view' }).selectOption(tier);
  await closeScorerSettings(scorer);
}

/** The owner's roster entry for one of its own scorers, by label; undefined while it is no member. */
function ownScorer(page: Page, label: string) {
  return page.evaluate((name) => (window as any).__media.links()
    .find((link: any) => link.kind === 'device' && link.own && link.scorer === name), label);
}

/** How many scorers this page has a ready link to — its own, or the thrower's if it is watching. */
function linkedScorers(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__media.links()
    .filter((link: any) => link.kind === 'device' && link.ready).length);
}

/** How many stills this scorer has taken: which phone photographed a dart, asked of the phone. */
function captured(scorer: Page): Promise<number> {
  return scorer.evaluate(() => (window as any).__media.stills().captured.length);
}

/** How many director commands this scorer has been sent. */
function directed(scorer: Page): Promise<number> {
  return scorer.evaluate(() => (window as any).__media.inbox().control
    .filter((message: any) => message.data?.kind === 'video_region').length);
}

/** The evidence thumbnails, as `<img>` elements — only the slots that actually hold a picture. */
function evidenceImages(page: Page) {
  return page.getByTestId('dart-evidence').locator('img');
}

/** Where a grid item sits, for asking whether dynamic content moved the match around. */
async function gridItemTop(page: Page, id: string): Promise<number> {
  return page.locator(`[data-grid-item="${id}"]`).evaluate((item) =>
    Math.round(item.getBoundingClientRect().top));
}

/** Ordered control-channel barrier: every message sent before this ping has reached the peer. */
async function controlRoundTrip(page: Page, peerId: string, seq: number): Promise<void> {
  const sent = await page.evaluate(({ id, value }) =>
    (window as any).__media.ping(id, value), { id: peerId, value: seq });
  expect(sent, `control channel to ${peerId} was not writable`).toBe(true);
  await expect.poll(() => page.evaluate(({ id, value }) =>
    (window as any).__media.inbox().control.some((message: any) =>
      message.from === id && message.data?.kind === 'pong' && message.data.seq === value),
  { id: peerId, value: seq })).toBe(true);
}

async function linkedToCamera(page: Page): Promise<void> {
  await expect.poll(() => linkedScorers(page), { timeout: 30_000 }).toBeGreaterThan(0);
}

/** An online match with Alice hosting, both taking part in media. */
async function onlineMatch(browser: Browser) {
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

test.describe('dart evidence', () => {
  test('a dart is photographed and reaches the thrower, the opponent and a spectator alike', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');
    // The third role. Evidence addresses all three roles, unlike live video, which deliberately
    // excludes the owner while still reaching opponents and spectators.
    const lobbyId = host.url().split('/lobby/')[1].split('?')[0].split('#')[0];
    const watching = await browser.newContext();
    const watcher = await watching.newPage();
    await watcher.goto(`/spectate/${lobbyId}?e2e=1`);
    // In the room before the match starts. Lobby membership is visible, but deliberately creates no
    // peer id; the identity arrives only after the match-scoped session exists.
    await expect(watcher.getByText('Online Match').first()).toBeVisible();

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await startScorerCamera(scorer.page);

    // Every viewer linked before a dart lands. A still is sent once, at the moment it is taken, and
    // there is no retry for a peer whose link was still being negotiated — so a spectator who joins
    // late misses that dart, which is honest behaviour and a race this test must not run into.
    await Promise.all([linkedToCamera(host), linkedToCamera(guest), linkedToCamera(watcher)]);

    // The strip is there before any picture is — that is the whole point of it having a fixed
    // height, and it is asserted before a dart is thrown rather than after.
    await expect(host.getByTestId('dart-evidence').first()).toBeVisible({ timeout: 20_000 });
    expect(await evidenceImages(host).count()).toBe(0);
    const boardTop = await gridItemTop(host, 'board');

    // A real inference on the board photograph: three darts land in Alice's visit at once, which is
    // also the burst the device's request queue exists for.
    await showScene(scorer.page, 'darts');
    await scan(scorer.page);
    await expect(host.getByText('Visit: 140')).toBeVisible({ timeout: 20_000 });

    // Alice threw, so Alice's frontend asked — and addressed the answer to all three roles. Bob and
    // the spectator asked nobody and get the same pictures anyway, which is the point: an observer's
    // copy of what a dart did cannot drift from the thrower's.
    await expect.poll(() => evidenceImages(host).count(), { timeout: 20_000 }).toBe(3);
    await expect.poll(() => evidenceImages(guest).count(), { timeout: 20_000 }).toBe(3);
    await expect.poll(() => evidenceImages(watcher).count(), { timeout: 20_000 }).toBe(3);

    const evidenceLayout = await host.locator('[data-grid-item="visit"]').evaluate((visit) => {
      const content = visit.querySelector<HTMLElement>('[data-grid-box-content]');
      const slot = visit.querySelector<HTMLElement>('[data-visit-slot]');
      const space = visit.querySelector<HTMLElement>('[data-testid="visit-evidence-space"]');
      const tile = visit.querySelector<HTMLElement>('[data-testid="dart-evidence"]');
      const footer = visit.querySelector<HTMLElement>('[data-testid="visit-footer"]');
      if (!content || !slot || !space || !tile || !footer) {
        throw new Error('visit layout is incomplete');
      }
      const box = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      return {
        content: box(content),
        slot: box(slot),
        space: box(space),
        tile: box(tile),
        footer: box(footer),
      };
    });

    // Fixed regions sit at the card edges. The evidence consumes the smaller of the remaining
    // height and one slot's width, stays square, and is centred when either axis has room left.
    expect(Math.abs(evidenceLayout.slot.y - evidenceLayout.content.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(
      evidenceLayout.footer.y + evidenceLayout.footer.height
        - evidenceLayout.content.y - evidenceLayout.content.height,
    )).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        evidenceLayout.tile.y + evidenceLayout.tile.height / 2
          - evidenceLayout.space.y - evidenceLayout.space.height / 2,
      ),
      JSON.stringify(evidenceLayout),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(evidenceLayout.tile.width - evidenceLayout.tile.height)).toBeLessThanOrEqual(1);
    expect(evidenceLayout.tile.width).toBeLessThanOrEqual(evidenceLayout.slot.width + 1);
    expect(Math.abs(
      evidenceLayout.tile.x + evidenceLayout.tile.width / 2
        - evidenceLayout.slot.x - evidenceLayout.slot.width / 2,
    )).toBeLessThanOrEqual(1);
    expect(Math.abs(
      evidenceLayout.tile.width - Math.min(evidenceLayout.slot.width, evidenceLayout.space.height),
    )).toBeLessThanOrEqual(1);

    // A real JPEG at the configured size, decoded by the browser rather than merely delivered.
    // Asked of the defaults rather than of a literal: this run has no settings file, so they are
    // what the server shipped, and the question is whether what arrives matches what was asked for.
    const decoded = await evidenceImages(host).first().evaluate((img: HTMLImageElement) =>
      img.decode().then(() => ({ w: img.naturalWidth, h: img.naturalHeight })));
    expect(decoded).toEqual({ w: CONFIG_DEFAULTS.media.still.size, h: CONFIG_DEFAULTS.media.still.size });

    // And the board did not move when the pictures arrived, which is the rule the fixed match-grid
    // height is there to keep. The Visit card uses the room inside that fixed box.
    expect(await gridItemTop(host, 'board')).toBe(boardTop);

    // Three darts, three different squares of the board — so three different pictures.
    //
    // The capture canvas is cached and shared between captures, which is what makes a burst cheap
    // and is also the one way this could go quietly wrong: a stale canvas, or a blob taken before
    // the next draw landed, would send the same photograph three times and nothing else here would
    // notice. Compared by size because two JPEGs of different crops cannot coincide in length.
    const sizes = await evidenceImages(host).evaluateAll((images) =>
      Promise.all(images.map((img) =>
        fetch((img as HTMLImageElement).src).then((r) => r.blob()).then((b) => b.size))));
    expect(sizes.length).toBe(3);
    expect(new Set(sizes).size, `three crops produced ${sizes.length - new Set(sizes).size + 1} identical images`).toBe(3);
    // The timings the diagnostics panel reads. Asserted because they are the only way anyone will
    // ever answer "why is this slow" on a real device, and an instrument that has quietly stopped
    // recording is worse than none — it reads as "nothing to see here".
    const captured = await scorer.page.evaluate(() => (window as any).__media.stills().captured);
    expect(captured.length).toBe(3);
    expect(captured.every((t: { encodeMs: number }) => Number.isFinite(t.encodeMs))).toBe(true);

    const received = await host.evaluate(() => (window as any).__media.stills().received);
    expect(received.length).toBe(3);
    expect(received.every((t: { roundTripMs: number }) => t.roundTripMs >= 0)).toBe(true);
    // And the camera's own account of who each picture was for, which is what makes a narrowed
    // audience visible rather than merely quiet.
    expect(captured.every((t: { audience: string[] }) =>
      [...t.audience].sort().join() === 'opponent,owner,spectator')).toBe(true);

    await alice.close();
    await bob.close();
    await watching.close();
    await scorer.context.close();
  });

  test('undo takes the evidence with it', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await startScorerCamera(scorer.page);
    await Promise.all([linkedToCamera(host), linkedToCamera(guest)]);

    await showScene(scorer.page, 'darts');
    await scan(scorer.page);
    await expect(host.getByText('Visit: 140')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => evidenceImages(host).count(), { timeout: 20_000 }).toBe(3);

    await host.getByRole('button', { name: 'Undo' }).click();

    // The picture describes a dart that is no longer in the visit, so it goes with it — on the
    // opponent's screen too, since they render the same visit from the same state.
    await expect.poll(() => evidenceImages(host).count(), { timeout: 10_000 }).toBe(2);
    await expect.poll(() => evidenceImages(guest).count(), { timeout: 10_000 }).toBe(2);

    await alice.close();
    await bob.close();
    await scorer.context.close();
  });

  test('survives a game mode that declined board video', async ({ browser }) => {
    // Whac-A-Mole draws its moles onto the board's own geometry and cannot have a photograph of a
    // real board laid over them, so it declines the feed. It says nothing about stills, and this is
    // the test that the two are separate features rather than one switch: the same camera, the same
    // nomination, the same pairing — a feed that never arrives and evidence that still does.
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');

    await host.getByLabel('Game').selectOption('whac-a-mole');
    await expect(host.getByText('Whac-A-Mole settings')).toBeVisible();
    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await startScorerCamera(scorer.page);
    await Promise.all([linkedToCamera(host), linkedToCamera(guest)]);

    await showScene(scorer.page, 'darts');
    await scan(scorer.page);

    // The evidence is untouched — asked for, taken, and delivered to the opponent as well.
    await expect.poll(() => evidenceImages(host).count(), { timeout: 20_000 }).toBe(3);
    await expect.poll(() => evidenceImages(guest).count(), { timeout: 20_000 }).toBe(3);

    // And the camera was never asked to publish, so there is nothing to offer, consent to, or draw.
    // The server withholds the source directive; nothing here depends on the frontend refusing.
    // Null rather than empty: no publisher was ever made, as against one made and then given
    // nobody to send to.
    expect(await scorer.page.evaluate(() => (window as any).__media.video().published)).toBeNull();
    await expect(host.getByTestId('live-board-feed')).toHaveCount(0);
    await expect(guest.getByTestId('live-board-feed')).toHaveCount(0);
    await expect(host.getByRole('dialog', { name: 'Live board video' })).toHaveCount(0);

    await alice.close();
    await bob.close();
    await scorer.context.close();
  });

  test('a camera answers its owner and ignores everybody else', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await startScorerCamera(scorer.page);
    await Promise.all([linkedToCamera(host), linkedToCamera(guest)]);
    await showScene(scorer.page, 'darts');
    await scan(scorer.page);

    // Bob can see Alice's camera — that link is the whole reason he sees her board — and asks it
    // directly, straight down the link, bypassing anything the interface would or would not offer.
    const cameraPeer = await guest.evaluate(() =>
      (window as any).__media.links().find((l: any) => l.kind === 'device'));
    expect(cameraPeer, 'the opponent should be linked to the board camera').toBeTruthy();
    expect(cameraPeer.own, 'and it is not his').toBe(false);

    const opponentRequestSent = await guest.evaluate((peerId) => (window as any).__media.sendControl(peerId, {
      kind: 'still_request', id: 'from-the-opponent', tag: { dart: 0 },
    }), cameraPeer.peerId);
    expect(opponentRequestSent, 'the opponent camera control channel was not writable').toBe(true);
    await controlRoundTrip(guest, cameraPeer.peerId, 801);

    // An authorized request is a deterministic queue barrier. If the opponent's request had been
    // accepted by mistake, the single serialized capture queue would finish and answer it before
    // this later owner request can be answered.
    const ownerCamera = await host.evaluate(() =>
      (window as any).__media.links().find((link: any) => link.kind === 'device'));
    const ownerRequestSent = await host.evaluate((peerId) => (window as any).__media.sendControl(peerId, {
      kind: 'still_request', id: 'owner-barrier', tag: { dart: 1 },
      region: { cx: 0.5, cy: 0.5, size: 0.25 },
      to: ['owner', 'opponent'],
    }), ownerCamera.peerId);
    expect(ownerRequestSent, 'the owner camera control channel was not writable').toBe(true);
    await expect.poll(() => guest.evaluate(() => (window as any).__media.inbox().control
      .some((message: any) => message.data?.id === 'owner-barrier')), { timeout: 20_000 }).toBe(true);

    // Silence. Not a refusal — a peer with no business asking learns nothing from an answer.
    const answers = await guest.evaluate(() => (window as any).__media.inbox().control
      .filter((m: any) => m.data?.id === 'from-the-opponent'));
    expect(answers).toEqual([]);

    await alice.close();
    await bob.close();
    await scorer.context.close();
  });
});

test.describe('several scorers at one board', () => {
  // Two phones and a model each, so these are the slowest tests in the file.
  test.setTimeout(180_000);

  test('the scorer that placed the dart photographs it, and the live camera is only directed', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    // Two phones at Alice's board with the same name. The first is the live camera and will see an
    // empty board; the second only sends stills, and will be the one that sees the darts.
    const live = await openScorer(browser);
    await pairAndNominate(host, live.page, 'Phone');
    const side = await openScorer(browser);
    await pair(host, side.page, 'Phone');
    await shareFromScorer(side.page, 'stills');
    // The owner tells them apart by the same label the detection record will use.
    await expect(scoringDeviceControls(host, 'Phone')).toBeVisible();
    await expect(scoringDeviceControls(host, 'Phone (2)')).toBeVisible();
    // The nomination is live video's alone, and the stills phone offers none.
    await expect(scoringDeviceControls(host, 'Phone (2)').getByRole('switch', { name: 'Board camera' })).toBeDisabled();
    await host.getByRole('button', { name: 'Cameras' }).first().click();

    const lobbyId = host.url().split('/lobby/')[1].split('?')[0].split('#')[0];
    const watching = await browser.newContext();
    const watcher = await watching.newPage();
    await watcher.goto(`/spectate/${lobbyId}?e2e=1`);
    await expect(watcher.getByText('Online Match').first()).toBeVisible();

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await Promise.all([startScorerCamera(live.page), startScorerCamera(side.page)]);

    // Both phones are members for every viewer. Only the owner is told which is which.
    for (const page of [host, guest, watcher]) {
      await expect.poll(() => linkedScorers(page), { timeout: 30_000 }).toBe(2);
    }
    expect(await ownScorer(host, 'Phone')).toMatchObject({ tier: 'video', live: true });
    expect(await ownScorer(host, 'Phone (2)')).toMatchObject({ tier: 'stills', live: false, cameraOn: true });
    const guestLinks = await guest.evaluate(() => (window as any).__media.links());
    expect(guestLinks.every((link: any) => link.scorer === undefined && link.live === undefined)).toBe(true);

    // One throw, two cameras reporting it: only the second phone can see the darts.
    await showScene(side.page, 'darts');
    await Promise.all([scan(live.page), scan(side.page)]);
    await expect(host.getByText('Visit: 140')).toBeVisible({ timeout: 20_000 });

    // Placed by the phone that saw them, of two active phones. Whether the live camera's empty report
    // made the same throw window depends on how long two inferences take side by side, so it may or
    // may not count as reporting.
    const tiles = host.getByTestId('dart-evidence');
    for (let index = 0; index < 3; index++) {
      await expect(tiles.nth(index)).toHaveAttribute('title', /^Detected by Phone \(2\) \(1\/[12]\/2\)$/);
    }

    // And photographed by it, for the thrower, the opponent and the spectator alike.
    await expect.poll(() => evidenceImages(host).count(), { timeout: 20_000 }).toBe(3);
    await expect.poll(() => evidenceImages(guest).count(), { timeout: 20_000 }).toBe(3);
    await expect.poll(() => evidenceImages(watcher).count(), { timeout: 20_000 }).toBe(3);
    expect(await captured(side.page)).toBe(3);
    expect(await captured(live.page)).toBe(0);
    // The camera move that goes with each picture is the live camera's, since only it has a feed.
    await expect.poll(() => directed(live.page), { timeout: 10_000 }).toBe(3);
    expect(await directed(side.page)).toBe(0);

    // Membership follows the camera: off takes the stills phone out of every roster, on brings it back.
    await host.getByRole('button', { name: 'Cameras' }).first().click();
    await scoringDeviceControls(host, 'Phone (2)').getByRole('button', { name: 'Camera off' }).click();
    await expect.poll(() => ownScorer(host, 'Phone (2)'), { timeout: 20_000 }).toBeUndefined();
    await expect.poll(() => linkedScorers(guest), { timeout: 20_000 }).toBe(1);
    await scoringDeviceControls(host, 'Phone (2)').getByRole('button', { name: 'Camera on' }).click();
    await expect.poll(() => ownScorer(host, 'Phone (2)'), { timeout: 30_000 }).toMatchObject({ cameraOn: true });
    await expect.poll(() => linkedScorers(guest), { timeout: 30_000 }).toBe(2);

    await alice.close();
    await bob.close();
    await watching.close();
    await live.context.close();
    await side.context.close();
  });

  test('falls back to the live camera for a dart whose scorer shares nothing, and for one added by hand', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const live = await openScorer(browser);
    await pairAndNominate(host, live.page, 'Alice board');
    const hidden = await openScorer(browser);
    await pair(host, hidden.page, 'Alice side');
    await shareFromScorer(hidden.page, 'disabled');
    await host.getByRole('button', { name: 'Cameras' }).first().click();

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await Promise.all([startScorerCamera(live.page), startScorerCamera(hidden.page)]);

    // A phone that shares nothing scores, but is in nobody's roster.
    await expect.poll(() => linkedScorers(host), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => linkedScorers(guest), { timeout: 30_000 }).toBe(1);
    expect(await ownScorer(host, 'Alice board')).toMatchObject({ live: true });
    expect(await ownScorer(host, 'Alice side')).toBeUndefined();

    // By hand first. No scorer placed it, so the first in line — the live camera — is asked.
    await clickT20(host);
    await expect(host.getByTestId('dart-evidence').first()).toHaveAttribute('title', 'Manually added');
    await expect.poll(() => evidenceImages(host).count(), { timeout: 20_000 }).toBe(1);
    expect(await captured(live.page)).toBe(1);
    await host.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => evidenceImages(host).count(), { timeout: 10_000 }).toBe(0);

    // Then a throw only the phone that shares nothing can see. It places the darts; the live camera,
    // the one scorer that can take a picture, photographs them.
    await showScene(hidden.page, 'darts');
    await Promise.all([scan(live.page), scan(hidden.page)]);
    await expect(host.getByText('Visit: 140')).toBeVisible({ timeout: 20_000 });
    const tiles = host.getByTestId('dart-evidence');
    for (let index = 0; index < 3; index++) {
      await expect(tiles.nth(index)).toHaveAttribute('title', /^Detected by Alice side \(1\/[12]\/2\)$/);
    }
    await expect.poll(() => evidenceImages(host).count(), { timeout: 20_000 }).toBe(3);
    await expect.poll(() => evidenceImages(guest).count(), { timeout: 20_000 }).toBe(3);
    expect(await captured(live.page)).toBe(4);
    expect(await captured(hidden.page)).toBe(0);

    await alice.close();
    await bob.close();
    await live.context.close();
    await hidden.context.close();
  });

  test('records a camera that stayed silent as expected but not reporting', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const live = await openScorer(browser);
    await pairAndNominate(host, live.page, 'Alice board');
    const quiet = await openScorer(browser);
    await pair(host, quiet.page, 'Alice side');
    await shareFromScorer(quiet.page, 'stills');
    await host.getByRole('button', { name: 'Cameras' }).first().click();

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await Promise.all([startScorerCamera(live.page), startScorerCamera(quiet.page)]);
    // Every viewer linked before the throw: a still goes out once, to whoever is linked by then.
    for (const page of [host, guest]) {
      await expect.poll(() => linkedScorers(page), { timeout: 30_000 }).toBe(2);
    }

    // Only the live camera looks. The other phone's camera is on, so the throw window waits for its
    // report, and closes on its timeout when none comes — a count that no longer depends on timing.
    await showScene(live.page, 'darts');
    await scan(live.page);
    await expect(host.getByText('Visit: 140')).toBeVisible({ timeout: 20_000 });
    const tiles = host.getByTestId('dart-evidence');
    for (let index = 0; index < 3; index++) {
      await expect(tiles.nth(index)).toHaveAttribute('title', 'Detected by Alice board (1/1/2)');
    }
    await expect.poll(() => evidenceImages(guest).count(), { timeout: 20_000 }).toBe(3);
    expect(await captured(live.page)).toBe(3);
    expect(await captured(quiet.page)).toBe(0);

    await alice.close();
    await bob.close();
    await live.context.close();
    await quiet.context.close();
  });

  test('has no evidence while its owner does not share media, and still says who placed each dart', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pair(host, scorer.page, 'Alice board');
    await setSwitch(host.getByRole('switch', { name: 'Share media' }), false);
    await host.getByRole('button', { name: 'Cameras' }).first().click();

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await startScorerCamera(scorer.page);

    await showScene(scorer.page, 'darts');
    await scan(scorer.page);
    await expect(host.getByText('Visit: 140')).toBeVisible({ timeout: 20_000 });

    // Nothing to wait for, on either screen, and no picture was ever asked for.
    await expect(host.getByRole('img', { name: /evidence unavailable/ })).toHaveCount(3);
    await expect(guest.getByRole('img', { name: /evidence unavailable/ })).toHaveCount(3);
    expect(await linkedScorers(guest)).toBe(0);
    expect(await captured(scorer.page)).toBe(0);
    // Scoring does not need media, and neither does the record of it.
    await expect(host.getByTestId('dart-evidence').first()).toHaveAttribute('title', 'Detected by Alice board (1/1/1)');

    await alice.close();
    await bob.close();
    await scorer.context.close();
  });
});
