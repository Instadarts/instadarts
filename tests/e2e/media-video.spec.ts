// Live board video end to end: a real camera, a real H.264 encoder, a real peer connection, and a
// real decoder painting a real picture on two frontends at once.
//
// `media-codec.spec.ts` already proves the primitive — canvas in, encoded chunks over a datachannel,
// pictures out. What is unproven until here is everything around it: that a feed asked for in the
// lobby survives into the match, that a camera publishes to its owner and to an opponent from one
// encoder, that only the owner can command it, and that a director's region actually moves the shot.
//
// Lives in the `heavy` project (see playwright.config.ts) because it drives a model and a software
// encoder at once, which is the load that provokes the scorer-power flake documented in
// docs/development.md.

import { test, expect, type Page, type Browser } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { installVirtualCamera, scan, showScene } from './virtualCamera';
import { CONFIG_DEFAULTS } from '../../src/shared/config';

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
  const page = await context.newPage();
  await installVirtualCamera(page, SCENES);
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
  return feeds.reduce((total: number, feed: any) => total + feed.stats.decoded, 0);
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

/** How many times a camera has told this page whether it is publishing. */
function videoStates(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__media.inbox().control
    .filter((m: any) => m.data?.kind === 'video_state').length);
}

/** How many times a camera has told this page that a feed is running but not for them. */
function notAddressed(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__media.inbox().control
    .filter((m: any) => m.data?.kind === 'video_state' && m.data.reason === 'not_addressed').length);
}

/** Who this device's feed is currently for. Null when nothing is publishing. */
function audienceOf(page: Page) {
  return page.evaluate(() => (window as any).__media.video().audience);
}

/**
 * Somebody watching the match who is in it for nothing.
 *
 * The third role, and the one the two halves of this feature treat differently: a spectator receives
 * dart evidence and must not receive a feed nobody addressed to them.
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
async function onlineMatch(browser: Browser) {
  const alice = await browser.newContext();
  const host = await alice.newPage();
  await host.goto('/?e2e=1');
  await host.click('text=Create Online Match');
  await host.fill('input[placeholder="New player name"]', 'Alice');
  await host.click('button:has-text("Add")');
  const code = (await host.locator('text=Invite Code').locator('..').locator('code').textContent())!;

  const bob = await browser.newContext();
  const guest = await bob.newPage();
  await guest.goto(`/lobby/join/${code.trim()}?e2e=1`);
  await guest.fill('input[placeholder="New player name"]', 'Bob');
  await guest.click('button:has-text("Add")');
  await expect(host.locator('text=Bob')).toBeVisible({ timeout: 5000 });

  return { alice, bob, host, guest };
}

test.describe('board video', () => {
  test('one encoder feeds exactly who it was told to, and re-addresses without restarting', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');
    const watching = await spectator(browser, host);

    // Asked for here, in the lobby, before there is any camera to answer with — which is the case
    // the device's "the owner's wish outlives the camera" rule exists for. Nothing is published yet.
    await expect.poll(() => cameraPeer(host), { timeout: 20_000 }).toBeTruthy();
    expect(await published(scorer.page)).toBeNull();

    await startCamera(scorer.page);

    // And now it is, without anybody asking a second time.
    await expect.poll(async () => (await published(scorer.page))?.frames ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(0);
    expect(await audienceOf(scorer.page)).toEqual(['owner']);

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');

    // Alice asked, and asked for herself alone. Bob and the spectator are linked to this camera —
    // that link is the only reason either of them could ever see her board — and get nothing from it.
    await expect.poll(() => decodedFrames(host), { timeout: 30_000 }).toBeGreaterThan(0);
    // Both links up *before* asserting they received nothing, or the assertion would be about a
    // negotiation that had not finished rather than about an audience.
    await linkedToCamera(guest);
    await linkedToCamera(watching.page);
    await host.waitForTimeout(2000);
    expect(await decodedFrames(guest), 'the opponent was sent a feed nobody addressed to them').toBe(0);
    expect(await decodedFrames(watching.page), 'a spectator was sent a feed nobody addressed to them').toBe(0);

    // And they are told why, rather than being left to tell a feed that is off from a link that is
    // broken from one that is simply not for them.
    for (const page of [guest, watching.page]) {
      await expect.poll(() => notAddressed(page), { timeout: 10_000 }).toBeGreaterThan(0);
    }

    // Now widen it. The opponent starts receiving — and the camera's frame counter carries on from
    // where it was rather than starting again, which is what says the encoder was not torn down to
    // change a recipient list.
    const framesBefore = (await published(scorer.page)).frames;
    const camera = await cameraPeer(host);
    await host.evaluate((peerId) => (window as any).__media.sendControl(peerId, {
      kind: 'video_start', to: ['owner', 'opponent'],
    }), camera.peerId);

    await expect.poll(() => decodedFrames(guest), { timeout: 30_000 }).toBeGreaterThan(0);
    expect(await audienceOf(scorer.page)).toEqual(['owner', 'opponent']);
    expect((await published(scorer.page)).frames, 'the encoder restarted to change an audience')
      .toBeGreaterThan(framesBefore);
    // The spectator was not in the wider list either.
    expect(await decodedFrames(watching.page)).toBe(0);

    // One encode, two viewers: nobody can have decoded a frame the camera never published.
    //
    // Read viewer-first and camera-second on purpose. Both counters are still climbing, and a camera
    // snapshot taken *before* the viewer's would be the older of the two — which fails on a feed
    // that is working perfectly.
    const decoded = await decodedFrames(host);
    const stats = await published(scorer.page);
    expect(stats.keyframes).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(decoded).toBeLessThanOrEqual(stats.frames);

    // A real picture at the profile's size, not a black rectangle. Asked of the constant rather than
    // a literal, so tuning the profile does not silently stop testing anything.
    const size = await host.evaluate(() => {
      const url = (window as any).__media.frame();
      return url ? new Promise<{ w: number; h: number }>((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ w: image.naturalWidth, h: image.naturalHeight });
        image.src = url;
      }) : null;
    });
    expect(size).toEqual({ w: CONFIG_DEFAULTS.media.video.size, h: CONFIG_DEFAULTS.media.video.size });

    const shot = (await fingerprint(host))!;
    expect(shot, 'no picture decoded').not.toBeNull();
    expect(Math.max(...shot) - Math.min(...shot), 'the picture is a flat colour').toBeGreaterThan(5);

    // A stop needs no roles: it is for everybody, and it is the only thing that ends a feed.
    await host.evaluate((peerId) => (window as any).__media.sendControl(peerId, { kind: 'video_stop' }), camera.peerId);
    await expect.poll(() => published(scorer.page), { timeout: 10_000 }).toBeNull();

    await alice.close();
    await bob.close();
    await watching.context.close();
    await scorer.context.close();
  });

  test('a director moves the shot, and everybody watching moves with it', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await startCamera(scorer.page);
    await expect.poll(() => decodedFrames(host), { timeout: 30_000 }).toBeGreaterThan(0);

    // Watched through the opponent, so "everybody watching moves with it" is about somebody who never
    // sent a command. The lobby feed is addressed to the owner alone, so this test has to widen it —
    // which is the honest way round: a test that needs an audience should ask for one.
    const camera = await cameraPeer(host);
    await host.evaluate((peerId) => (window as any).__media.sendControl(peerId, {
      kind: 'video_start', to: ['owner', 'opponent'],
    }), camera.peerId);
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
    // Watched through Alice: the feed is addressed to her alone, and what must survive Bob's meddling
    // is *her* picture. He has none, which is the previous test's business.
    await expect.poll(() => decodedFrames(host), { timeout: 30_000 }).toBeGreaterThan(0);

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
    // Counted rather than required to be empty: Bob has legitimately heard `video_state` already —
    // the camera told every viewer `no_camera` before it was started, and tells the unaddressed ones
    // `not_addressed` once it is. What must not happen is a *new* one caused by him.
    const statesBefore = await videoStates(guest);
    const shotBefore = (await fingerprint(host))!;

    await guest.evaluate((peerId) => {
      (window as any).__media.sendControl(peerId, { kind: 'video_stop' });
      (window as any).__media.sendControl(peerId, { kind: 'video_region', region: { cx: 0.1, cy: 0.1, size: 0.05 }, transitionMs: 0 });
    }, camera.peerId);
    await guest.waitForTimeout(2000);

    // Nothing happens. An opponent cannot switch off somebody else's camera and cannot decide what it
    // looks at — and gets silence rather than a refusal, because a peer with no business commanding
    // learns nothing from an answer.
    expect((await published(scorer.page)).frames, 'the opponent stopped the feed').toBeGreaterThan(beforeStop);
    expect(await videoStates(guest), 'the camera answered a peer it should have ignored').toBe(statesBefore);
    expect(distance(shotBefore, (await fingerprint(host))!), 'the opponent moved the shot').toBeLessThan(8);

    await alice.close();
    await bob.close();
    await scorer.context.close();
  });

  test('a stills-only camera says so rather than publishing', async ({ browser }) => {
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

    await expect
      .poll(() => host.evaluate(() => (window as any).__media.inbox().control
        .filter((m: any) => m.data?.kind === 'video_state' && m.data.reason === 'not_offered').length), { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect(await published(scorer.page)).toBeNull();

    await alice.close();
    await bob.close();
    await scorer.context.close();
  });
});
