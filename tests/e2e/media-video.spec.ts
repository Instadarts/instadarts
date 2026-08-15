// Live board video end to end: a real camera, a real H.264 encoder, a real peer connection, and a
// real decoder painting the production match board on two frontends at once.
//
// `media-codec.spec.ts` already proves the primitive — canvas in, encoded chunks over a datachannel,
// pictures out. What is unproven until here is everything around it: that a lobby offers nothing,
// that a match offers eligible opponents and spectators a choice, that only accepted peers receive
// frames, that turns only change which received feed is displayed, that only the owner can command
// it, and that a director's region actually moves the shot.
//
// Lives in the `heavy` project (see playwright.config.ts) because it drives a model and a software
// encoder at once, which is the load that provokes the scorer-power flake documented in
// docs/development.md.

import { test, expect, type Page, type Browser } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { installFakeCamera, scan, showScene } from './fakeCamera';
import { CONFIG_DEFAULTS } from '../../src/shared/config';
import { clickT20, skipOnboarding, submitVisit } from './appHelpers';

// `empty` first, so that is what the camera opens on: the first key is the initial scene, and a
// feed that starts by showing a board nobody has thrown at is the honest starting state.
const SCENES = {
  empty: fileURLToPath(new URL('../media/board-empty.jpg', import.meta.url)),
  darts: fileURLToPath(new URL('../media/board-three-darts.jpg', import.meta.url)),
};

/** Loading a 2.4MB model, running it, and encoding H.264 in software is not quick. */
test.setTimeout(120_000);

async function openScorer(browser: Browser) {
  const context = await browser.newContext({ permissions: ['camera'] });
  await skipOnboarding(context);
  const page = await context.newPage();
  await installFakeCamera(page, SCENES);
  await page.goto('/scorer?e2e=1');
  return { context, page };
}

/** Pair this phone to that frontend and nominate it as the board camera. */
async function pairAndNominate(player: Page, scorer: Page, name: string) {
  await player.getByRole('button', { name: 'Cameras' }).first().click();
  await player.getByRole('button', { name: 'Pair scoring device' }).click();
  const code = (await player.locator('p.font-mono.tracking-\\[0\\.3em\\]').textContent())!.trim();

  await scorer.getByPlaceholder('CODE').fill(code);
  await scorer.getByRole('button', { name: 'Pair' }).click();
  await scorer.getByPlaceholder('Name this device').fill(name);
  await scorer.getByPlaceholder('Name this device').blur();

  await player.getByRole('radio', { name: `Board camera: ${name}` }).check();
  await player.getByRole('button', { name: 'Cameras' }).first().click();
}

async function startCamera(page: Page) {
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByRole('button', { name: 'Stop scanning' })).toBeEnabled({ timeout: 90_000 });
  await page.evaluate(() => (window as unknown as { __scorer: { motion: { disarm: () => void } } }).__scorer.motion.disarm());
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** What this device's own camera has published. */
function published(page: Page) {
  return page.evaluate(() => (window as any).__media.video().published);
}

/** What this frontend has managed to decode, across every feed it is watching. */
function watching(page: Page) {
  return page.evaluate(() => (window as any).__media.video().watching);
}

async function decodedFrames(page: Page): Promise<number> {
  const feeds = await watching(page);
  return feeds.reduce((total: number, feed: any) => total + (feed.stats?.decoded ?? 0), 0);
}

/** The board camera, as this page's roster sees it. */
function cameraPeer(page: Page) {
  return page.evaluate(() => (window as any).__media.links().find((l: any) => l.kind === 'device'));
}

/**
 * Wait until this page could actually receive from the camera.
 *
 * Load-bearing wherever a test asserts that something did **not** arrive: a peer whose link is still
 * being negotiated receives nothing for reasons that have nothing to do with an audience, so an
 * assertion made too early passes for the wrong reason and would go on passing if the filter were
 * removed. It is the difference between "was not sent this" and "was not ready for anything".
 */
async function linkedToCamera(page: Page) {
  await expect
    .poll(() => page.evaluate(() => (window as any).__media.links()
      .filter((l: any) => l.kind === 'device' && l.ready).length), { timeout: 30_000 })
    .toBeGreaterThan(0);
}

/** Offer/end lifecycle messages received by this page. */
function videoLifecycleMessages(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__media.inbox().control
    .filter((m: any) => m.data?.kind === 'video_offer' || m.data?.kind === 'video_end').length);
}

/** The standing source offer, which exists before and after its encoder. */
function sourceOffer(page: Page) {
  return page.evaluate(() => (window as any).__media.video().offer);
}

async function acceptOffer(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Live board video' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Show video' }).click();
}

async function declineOffer(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Live board video' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Use virtual board' }).click();
}

/**
 * Somebody watching the match who is in it for nothing.
 *
 * The third role: a spectator receives both players' nominated feeds and displays the current one.
 */
async function spectator(browser: Browser, host: Page) {
  const url = host.url();
  const id = url.split('/lobby/')[1].split('?')[0].split('#')[0];
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/spectate/${id}?e2e=1`);
  // In the room before the caller does anything else. The id in that URL is a *lobby's*, and a
  // `spectate` that arrives after the lobby has become a match is asking for something that no
  // longer exists — a race that has nothing to do with media and would look exactly like one.
  await expect.poll(() => page.evaluate(() => (window as any).__media.self()), { timeout: 20_000 })
    .toBeTruthy();
  return { context, page };
}

/**
 * A coarse fingerprint of the decoded picture: mean luma over an 8×8 grid.
 *
 * Compared rather than read. Two shots of the same static scene differ only by codec noise, so the
 * distance between successive frames is the floor that a real camera move has to clear — which is
 * what makes "the picture changed" an assertion rather than a coin toss.
 */
async function fingerprint(page: Page): Promise<number[] | null> {
  return page.evaluate(async () => {
    const url = (window as any).__media.frame();
    if (!url) return null;
    const image = new Image();
    image.src = url;
    await image.decode();

    const grid = document.createElement('canvas');
    grid.width = 8;
    grid.height = 8;
    const ctx = grid.getContext('2d')!;
    ctx.drawImage(image, 0, 0, 8, 8);
    const { data } = ctx.getImageData(0, 0, 8, 8);

    const cells: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      cells.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
    return cells;
  });
}

function distance(a: number[], b: number[]): number {
  return a.reduce((total, value, i) => total + Math.abs(value - b[i]), 0) / a.length;
}

/** An online match with Alice hosting, both taking part in media. */
async function onlineMatch(browser: Browser, guestDiagnostics = true) {
  const alice = await browser.newContext();
  const host = await alice.newPage();
  await host.goto('/?e2e=1');
  await host.click('text=Create Online Match');
  await host.fill('input[placeholder="New player name"]', 'Alice');
  await host.click('button:has-text("Add")');
  const code = (await host.locator('text=Invite Code').locator('..').locator('code').textContent())!;

  const bob = await browser.newContext();
  const guest = await bob.newPage();
  await guest.goto(`/lobby/join/${code.trim()}${guestDiagnostics ? '?e2e=1' : ''}`);
  await guest.fill('input[placeholder="New player name"]', 'Bob');
  await guest.click('button:has-text("Add")');
  await expect(host.locator('text=Bob')).toBeVisible({ timeout: 5000 });

  return { alice, bob, host, guest };
}

test.describe('board video', () => {
  test('the match publishes one remote feed continuously and displays it only on the right turns', async ({ browser }) => {
    // Bob deliberately runs without `?e2e=1`: the visible product feed must not depend on diagnostics.
    const { alice, bob, host, guest } = await onlineMatch(browser, false);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');
    const watching = await spectator(browser, host);

    // A nominated, running camera in an online lobby must still publish nothing.
    await expect.poll(() => cameraPeer(host), { timeout: 20_000 }).toBeTruthy();
    await startCamera(scorer.page);
    await host.waitForTimeout(1500);
    expect(await published(scorer.page)).toBeNull();

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');

    // Offers do not cost an encoder. Each recipient makes an independent choice; Bob declines first
    // and can change that choice from the persistent board control.
    await expect.poll(() => sourceOffer(scorer.page), { timeout: 20_000 }).toBeTruthy();
    const firstFeedId = (await sourceOffer(scorer.page)).feedId;
    expect(await published(scorer.page)).toBeNull();
    await expect(host.getByRole('dialog', { name: 'Live board video' })).toHaveCount(0);
    await declineOffer(guest);
    await acceptOffer(watching.page);
    await expect.poll(async () => (await published(scorer.page))?.frames ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(0);
    expect((await sourceOffer(scorer.page)).audience).toEqual(['opponent', 'spectator']);
    expect((await sourceOffer(scorer.page)).accepted).toHaveLength(1);
    await expect(guest.getByRole('button', { name: 'Play live video from Alice board' })).toBeVisible();
    await guest.getByRole('button', { name: 'Play live video from Alice board' }).click();

    // Alice is current. Bob and the spectator receive and display her board; Alice is deliberately
    // outside the audience and keeps the ordinary virtual board.
    await linkedToCamera(watching.page);
    await expect.poll(() => decodedFrames(watching.page), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(guest.getByTestId('live-board-feed')).toBeVisible();
    await expect(watching.page.getByTestId('live-board-feed')).toBeVisible();
    await expect(host.getByTestId('live-board-feed')).toHaveCount(0);
    await expect(host.getByTestId('dartboard')).toBeVisible();
    expect(await decodedFrames(host), 'the owner received their own video').toBe(0);
    expect(await guest.evaluate(() => '__media' in window), 'the product frontend accidentally enabled diagnostics').toBe(false);

    // One encode, two remote viewers: nobody can have decoded a frame the camera never published.
    //
    // Read viewer-first and camera-second on purpose. Both counters are still climbing, and a camera
    // snapshot taken *before* the viewer's would be the older of the two — which fails on a feed
    // that is working perfectly.
    const decoded = await decodedFrames(watching.page);
    const stats = await published(scorer.page);
    expect(stats.keyframes).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(decoded).toBeLessThanOrEqual(stats.frames);

    // A real picture at the profile's size, not a black rectangle. Asked of the constant rather than
    // a literal, so tuning the profile does not silently stop testing anything.
    const size = await watching.page.evaluate(() => {
      const url = (window as any).__media.frame();
      return url ? new Promise<{ w: number; h: number }>((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ w: image.naturalWidth, h: image.naturalHeight });
        image.src = url;
      }) : null;
    });
    expect(size).toEqual({ w: CONFIG_DEFAULTS.media.video.size, h: CONFIG_DEFAULTS.media.video.size });

    const shot = (await fingerprint(watching.page))!;
    expect(shot, 'no picture decoded').not.toBeNull();
    expect(Math.max(...shot) - Math.min(...shot), 'the picture is a flat colour').toBeGreaterThan(5);

    // Diagnostics remain available under the E2E seam, but own no picture or clip recorder.
    for (const page of [scorer.page, watching.page]) {
      const panel = page.getByTestId('media-debug');
      await panel.getByRole('button').click();
      await expect(panel).not.toContainText(/record|save clip/i);
      await expect(panel.locator('canvas, video')).toHaveCount(0);
    }
    await expect(scorer.page.getByTestId('media-debug')).toContainText('opponent spectator · 2 accepted');
    await expect(watching.page.getByTestId('media-debug')).toContainText('Alice board · accepted');

    // Closing both copies stops the encoder but not the standing offer. Reaccepting resumes the
    // same UUID and does not open another consent dialog.
    await guest.getByRole('button', { name: 'Stop live video from Alice board' }).click();
    await watching.page.getByRole('button', { name: 'Stop live video from Alice board' }).click();
    await expect.poll(() => published(scorer.page), { timeout: 10_000 }).toBeNull();
    expect((await sourceOffer(scorer.page)).feedId).toBe(firstFeedId);
    await guest.getByRole('button', { name: 'Play live video from Alice board' }).click();
    await watching.page.getByRole('button', { name: 'Play live video from Alice board' }).click();
    await expect.poll(async () => (await published(scorer.page))?.frames ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(0);
    await expect(guest.getByRole('dialog', { name: 'Live board video' })).toHaveCount(0);

    // Camera shutdown pauses the encoder, not the offer or the recipient's choice. The virtual board
    // takes over and the same UUID resumes without another prompt.
    await scorer.page.getByRole('button', { name: 'Off' }).click();
    await expect.poll(() => published(scorer.page), { timeout: 10_000 }).toBeNull();
    expect((await sourceOffer(scorer.page)).feedId).toBe(firstFeedId);
    await expect(guest.getByTestId('live-board-feed')).toHaveCount(0, { timeout: 5000 });
    await expect(guest.getByRole('button', { name: 'Stop live video from Alice board' })).toBeVisible();
    await startCamera(scorer.page);
    await expect.poll(async () => (await published(scorer.page))?.frames ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(0);
    expect((await sourceOffer(scorer.page)).feedId).toBe(firstFeedId);
    await expect(guest.getByRole('dialog', { name: 'Live board video' })).toHaveCount(0);

    // Hand the turn to Bob. Alice's feed remains encoded and decoded but is hidden on both remote
    // screens because no Bob camera exists; the virtual board is immediately visible underneath.
    const framesBeforeTurn = (await published(scorer.page)).frames;
    const spectatorDecodedBeforeTurn = await decodedFrames(watching.page);
    await host.getByRole('button', { name: 'Submit Visit' }).click();
    await expect(guest.getByTestId('live-board-feed')).toHaveCount(0);
    await expect(watching.page.getByTestId('live-board-feed')).toHaveCount(0);
    await expect(guest.getByTestId('dartboard')).toBeVisible();
    await expect.poll(async () => (await published(scorer.page)).frames, { timeout: 10_000 })
      .toBeGreaterThan(framesBeforeTurn);
    await expect.poll(() => decodedFrames(watching.page), { timeout: 10_000 })
      .toBeGreaterThan(spectatorDecodedBeforeTurn);

    // Alice becomes current again and the already-running feed is revealed without a restart.
    await guest.getByRole('button', { name: 'Submit Visit' }).click();
    await expect(guest.getByTestId('live-board-feed')).toBeVisible();
    await expect(watching.page.getByTestId('live-board-feed')).toBeVisible();
    expect((await published(scorer.page)).frames).toBeGreaterThan(framesBeforeTurn);

    // Camera nomination and the frontend media switch are both hard opt-outs. Removing either drops
    // the ownership edge, stops the scorer's otherwise orphaned encoder, and uncovers the fallback.
    await host.getByRole('button', { name: /Cameras/ }).first().click();
    await host.getByRole('radio', { name: 'Board camera: none' }).check();
    await expect.poll(() => published(scorer.page), { timeout: 10_000 }).toBeNull();
    await expect(guest.getByTestId('live-board-feed')).toHaveCount(0);
    await expect(watching.page.getByTestId('live-board-feed')).toHaveCount(0);

    await host.getByRole('radio', { name: 'Board camera: Alice board' }).check();
    await declineOffer(guest);
    await acceptOffer(watching.page);
    await guest.getByRole('button', { name: 'Play live video from Alice board' }).click();
    await expect.poll(async () => (await published(scorer.page))?.frames ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(0);
    expect((await sourceOffer(scorer.page)).feedId).not.toBe(firstFeedId);
    await expect(guest.getByTestId('live-board-feed')).toBeVisible();
    await host.getByRole('checkbox', { name: 'Share and watch live video during a match' }).uncheck();
    await expect.poll(() => published(scorer.page), { timeout: 10_000 }).toBeNull();
    await expect(guest.getByTestId('live-board-feed')).toHaveCount(0);
    await expect(guest.getByTestId('dartboard')).toBeVisible();

    await alice.close();
    await bob.close();
    await watching.context.close();
    await scorer.context.close();
  });

  test('a spectator switches between two independently accepted player feeds', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const aliceScorer = await openScorer(browser);
    const bobScorer = await openScorer(browser);
    await pairAndNominate(host, aliceScorer.page, 'Alice board');
    await pairAndNominate(guest, bobScorer.page, 'Bob board');
    const watching = await spectator(browser, host);

    await startCamera(aliceScorer.page);
    await startCamera(bobScorer.page);
    expect(await published(aliceScorer.page)).toBeNull();
    expect(await published(bobScorer.page)).toBeNull();

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await acceptOffer(guest);
    await acceptOffer(host);
    await acceptOffer(watching.page);
    await acceptOffer(watching.page);
    await expect.poll(async () => (await published(aliceScorer.page))?.frames ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect.poll(async () => (await published(bobScorer.page))?.frames ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect(watching.page.getByRole('button', { name: 'Stop live video from Alice board' })).toBeVisible();
    await expect(watching.page.getByRole('button', { name: 'Stop live video from Bob board' })).toBeVisible();

    // Alice starts. Bob and the spectator see Alice; Alice does not receive her own feed.
    await expect(guest.getByTestId('live-board-feed')).toHaveAttribute('aria-label', 'Live board video: Alice board');
    await expect(watching.page.getByTestId('live-board-feed')).toHaveAttribute('aria-label', 'Live board video: Alice board');
    await expect(host.getByTestId('live-board-feed')).toHaveCount(0);

    const aliceFrames = (await published(aliceScorer.page)).frames;
    const bobFrames = (await published(bobScorer.page)).frames;
    await host.getByRole('button', { name: 'Submit Visit' }).click();

    // Bob's turn selects the other already-decoding feed everywhere it should. Neither publisher
    // restarts or pauses merely because its picture is currently hidden.
    await expect(host.getByTestId('live-board-feed')).toHaveAttribute('aria-label', 'Live board video: Bob board');
    await expect(watching.page.getByTestId('live-board-feed')).toHaveAttribute('aria-label', 'Live board video: Bob board');
    await expect(guest.getByTestId('live-board-feed')).toHaveCount(0);
    await expect.poll(async () => (await published(aliceScorer.page)).frames, { timeout: 10_000 })
      .toBeGreaterThan(aliceFrames);
    await expect.poll(async () => (await published(bobScorer.page)).frames, { timeout: 10_000 })
      .toBeGreaterThan(bobFrames);

    await alice.close();
    await bob.close();
    await watching.context.close();
    await aliceScorer.context.close();
    await bobScorer.context.close();
  });

  test('a director moves the shot, and everybody watching moves with it', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await startCamera(scorer.page);
    await acceptOffer(guest);
    // Watched through the opponent after its explicit consent.
    await expect.poll(() => decodedFrames(guest), { timeout: 30_000 }).toBeGreaterThan(0);

    // Locate the board on an empty one *first*, and this is the whole reason the empty scene is here.
    // A feed opens on the camera's own square and slides to the board when a homography turns up, so
    // a baseline taken before that would move on its own — and the test would pass whether or not any
    // director command did anything at all.
    await scan(scorer.page);
    await expect.poll(() => scorer.page.evaluate(() =>
      (window as unknown as { __scorer: { located: boolean } }).__scorer.located), { timeout: 30_000 }).toBe(true);

    // The darts go up on the board **before** the baseline is taken, and nothing else in this test
    // changes the scene again. That is what makes the assertions below about the director and only
    // about the director: a baseline taken before the scene changed would move when the scene did,
    // and the test would pass whether or not a single command was honoured.
    await showScene(scorer.page, 'darts');
    await guest.waitForTimeout(2000);

    // The floor: two shots of one static, board-framed scene a moment apart. Whatever they differ by
    // is codec noise, and a real camera move has to clear it by a distance.
    const wide = (await fingerprint(guest))!;
    await guest.waitForTimeout(700);
    const drift = distance(wide, (await fingerprint(guest))!);

    // Now the darts are *scored*. Alice's frontend asks for each one's photograph and, at the same
    // moment and the same square, tells the camera to go and look at it.
    await scan(scorer.page);
    await expect(host.getByText('Visit: 140')).toBeVisible({ timeout: 20_000 });

    // A quarter of the board instead of all of it — on the *opponent's* screen, who never sent a
    // command and is watching the shot Alice called.
    await expect
      .poll(async () => distance(wide, (await fingerprint(guest)) ?? wide), { timeout: 20_000 })
      .toBeGreaterThan(Math.max(drift * 4, 5));

    // And back on its own, with nobody sending a second command — which is what `resetMs` is for. A
    // director command is fire-and-forget, so a camera that only moved when told would sit on the
    // last dart of the evening.
    await expect
      .poll(async () => distance(wide, (await fingerprint(guest)) ?? wide), { timeout: 20_000 })
      .toBeLessThan(Math.max(drift * 4, 5));

    await alice.close();
    await bob.close();
    await scorer.context.close();
  });

  test('a camera takes commands from its owner and from nobody else', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await startCamera(scorer.page);
    await acceptOffer(guest);
    // Watched through Bob, who accepted Alice's board but has no authority over her camera.
    await expect.poll(() => decodedFrames(guest), { timeout: 30_000 }).toBeGreaterThan(0);

    // Bob is linked to Alice's camera — that link is the only reason he could ever see her board —
    // and goes straight down it, bypassing anything the interface would or would not offer him.
    //
    // Waited for rather than assumed, because the count below is only meaningful once it has stopped
    // moving for reasons of its own: a camera says its state again whenever the set of peers that can
    // hear it changes, so a link finishing its negotiation mid-window is an announcement that nothing
    // Bob did caused.
    await linkedToCamera(guest);
    const camera = await cameraPeer(guest);
    expect(camera.own, 'the camera is not the opponent\'s').toBe(false);

    const beforeStop = (await published(scorer.page)).frames;
    // Counted rather than required to be empty: Bob has legitimately heard an offer already.
    // What must not happen is a *new* one caused by him.
    const lifecycleBefore = await videoLifecycleMessages(guest);
    const shotBefore = (await fingerprint(guest))!;
    const activeOffer = await sourceOffer(scorer.page);

    // Even knowing the UUID does not widen the audience: the owner is linked to its camera but is
    // outside the owner-declared opponent/spectator roles.
    const ownerCamera = await cameraPeer(host);
    await host.evaluate(({ peerId, feedId }) => {
      (window as any).__media.sendControl(peerId, { kind: 'video_accept', feedId });
    }, { peerId: ownerCamera.peerId, feedId: activeOffer.feedId });
    await expect.poll(async () => (await sourceOffer(scorer.page)).accepted.length).toBe(1);
    expect(await decodedFrames(host)).toBe(0);

    await guest.evaluate((peerId) => {
      (window as any).__media.sendControl(peerId, { kind: 'video_stop' });
      (window as any).__media.sendControl(peerId, { kind: 'video_region', region: { cx: 0.1, cy: 0.1, size: 0.05 }, transitionMs: 0 });
    }, camera.peerId);
    await guest.waitForTimeout(2000);

    // Nothing happens. An opponent cannot switch off somebody else's camera and cannot decide what it
    // looks at — and gets silence rather than a refusal, because a peer with no business commanding
    // learns nothing from an answer.
    expect((await published(scorer.page)).frames, 'the opponent stopped the feed').toBeGreaterThan(beforeStop);
    expect(await videoLifecycleMessages(guest), 'the camera answered a peer it should have ignored').toBe(lifecycleBefore);
    expect(distance(shotBefore, (await fingerprint(guest))!), 'the opponent moved the shot').toBeLessThan(8);

    // The owner ends this exact UUID. One end clears the UI, and a late accept for that UUID is
    // deliberately ignored without recreating either the offer or the encoder.
    const endsBefore = await guest.evaluate(() => (window as any).__media.inbox().control
      .filter((m: any) => m.data?.kind === 'video_end').length);
    await host.evaluate((peerId) => {
      (window as any).__media.sendControl(peerId, { kind: 'video_stop' });
    }, ownerCamera.peerId);
    await expect.poll(() => sourceOffer(scorer.page), { timeout: 10_000 }).toBeNull();
    await expect.poll(() => guest.evaluate(() => (window as any).__media.inbox().control
      .filter((m: any) => m.data?.kind === 'video_end').length)).toBe(endsBefore + 1);
    await expect(guest.getByRole('button', { name: /live video from Alice board/ })).toHaveCount(0);
    await guest.evaluate(({ peerId, feedId }) => {
      (window as any).__media.sendControl(peerId, { kind: 'video_accept', feedId });
    }, { peerId: camera.peerId, feedId: activeOffer.feedId });
    await guest.waitForTimeout(500);
    expect(await sourceOffer(scorer.page)).toBeNull();
    expect(await published(scorer.page)).toBeNull();

    await alice.close();
    await bob.close();
    await scorer.context.close();
  });

  test('a stills-only camera offers and publishes no video', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');

    // The other half of the two gates: this phone's owner has offered stills, and no amount of
    // asking from the frontend that claimed it changes what the hardware is willing to send. Set
    // through the settings screen rather than through storage, because the point is that it is the
    // phone's own answer and its owner is the one who gives it.
    await scorer.page.getByRole('button', { name: 'Settings' }).click();
    await scorer.page.getByRole('combobox', { name: 'Share this view' }).selectOption('stills');
    await scorer.page.getByRole('button', { name: 'Done' }).click();

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await startCamera(scorer.page);

    // The frontend will not have asked — it can see the tier in the roster — so ask by hand, which
    // is what tests the device's own gate rather than the frontend's politeness.
    //
    // Waiting for the link and not merely for the roster entry, because asking by hand skips the
    // retry the app itself has: `useVideoFeed` only records that it asked when `sendControl`
    // reported the message went, and tries again when the links change. A bare `sendControl` on a
    // channel that is still opening is dropped, and the refusal being waited for below would never
    // be sent — a camera that was never asked looks exactly like one that ignored the question.
    await linkedToCamera(host);
    const camera = await cameraPeer(host);
    expect(camera.tier).toBe('stills');
    await host.evaluate((peerId) => (window as any).__media.sendControl(peerId, { kind: 'video_start' }), camera.peerId);

    await host.waitForTimeout(1500);
    expect(await sourceOffer(scorer.page)).toBeNull();
    await expect(guest.getByRole('dialog', { name: 'Live board video' })).toHaveCount(0);
    expect(await published(scorer.page)).toBeNull();
    await expect(guest.getByTestId('live-board-feed')).toHaveCount(0);
    await expect(guest.getByTestId('dartboard')).toBeVisible();

    await alice.close();
    await bob.close();
    await scorer.context.close();
  });

  test('a local match offers one shared board feed only to spectators', async ({ browser }) => {
    const local = await browser.newContext();
    const player = await local.newPage();
    await player.goto('/?e2e=1');
    await player.click('text=Local Match');
    await player.fill('input[placeholder="New player name"]', 'Alice');
    await player.click('button:has-text("Add")');
    await player.fill('input[placeholder="New player name"]', 'Bob');
    await player.click('button:has-text("Add")');

    const scorer = await openScorer(browser);
    await pairAndNominate(player, scorer.page, 'Local board');
    await startCamera(scorer.page);
    expect(await published(scorer.page)).toBeNull();

    await player.click('text=Start Match');
    await player.waitForURL('**/match/**');
    const matchId = player.url().split('/match/')[1].split('?')[0];

    await expect.poll(() => sourceOffer(scorer.page), { timeout: 10_000 }).toMatchObject({
      audience: ['spectator'],
      accepted: [],
    });
    expect(await published(scorer.page)).toBeNull();
    await expect(player.getByRole('dialog', { name: 'Live board video' })).toHaveCount(0);
    await expect(player.getByTestId('live-board-feed')).toHaveCount(0);
    await expect(player.getByTestId('dartboard')).toBeVisible();

    const watchingContext = await browser.newContext();
    const watcher = await watchingContext.newPage();
    await watcher.goto(`/spectate/${matchId}?e2e=1`);
    await acceptOffer(watcher);
    await expect.poll(() => published(scorer.page), { timeout: 20_000 }).not.toBeNull();
    await expect(watcher.getByTestId('live-board-feed')).toBeVisible({ timeout: 20_000 });

    const [shared] = await watching(watcher);
    expect(shared.playerId).toBeUndefined();
    const sharedFeedId = shared.feedId;

    // Alice hands the shared physical board to Bob. The spectator keeps the same unassigned feed;
    // local player IDs do not select between cameras because there is only this one camera.
    await clickT20(player);
    await submitVisit(player);
    await expect(watcher.getByTestId('live-board-feed')).toBeVisible();
    expect((await watching(watcher))[0].feedId).toBe(sharedFeedId);

    await watchingContext.close();
    await local.close();
    await scorer.context.close();
  });
});
