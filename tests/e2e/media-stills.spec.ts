// Dart evidence, end to end: a real board photo, a real inference, a real peer connection, and a
// real JPEG arriving on both sides of a match.
//
// Nothing here is stubbed after the camera. The device solves a homography from the photograph,
// inverts it to find the quarter of the board a dart landed in, crops its own frame and encodes it;
// the frontends decode what comes back. That whole chain is what makes it worth a heavy test — the
// arithmetic in it is exercised by tests/unit/still.test.ts, but whether the pieces fit together is
// only answerable here.
//
// Lives in the `heavy` project (see playwright.config.ts) because it drives a model, and that is the
// load that provokes the scorer-power flake documented in docs/development.md.

import { test, expect, type Page, type Browser } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { installVirtualCamera, scan, showScene } from './virtualCamera';
import { CONFIG_DEFAULTS } from '../../src/shared/config';

const SCENES = {
  darts: fileURLToPath(new URL('../media/board-three-darts.jpg', import.meta.url)),
};

/** Loading a 2.4MB model and running it is slower than clicking a button. */
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
  // Motion stays disarmed: frame differencing over a captured canvas is not deterministic, and the
  // gate is not what this test is about.
  await page.evaluate(() => (window as unknown as { __scorer: { motion: { disarm: () => void } } }).__scorer.motion.disarm());
}

/** The evidence thumbnails, as `<img>` elements — only the slots that actually hold a picture. */
function evidenceImages(page: Page) {
  return page.getByTestId('dart-evidence').locator('img');
}

/** Where the dart slots sit, for asking whether the screen moved. */
async function slotRowTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const strip = document.querySelector('[data-testid="dart-evidence"]');
    return strip ? Math.round(strip.getBoundingClientRect().top) : -1;
  });
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

test.describe('dart evidence', () => {
  test('a dart is photographed and reaches the thrower, the opponent and a spectator alike', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');
    // The third role. Evidence addresses all of them, which is what makes it the opposite case to
    // the owner-only feed in media-video.spec.ts — the two halves of the same mechanism.
    const lobbyId = host.url().split('/lobby/')[1].split('?')[0].split('#')[0];
    const watching = await browser.newContext();
    const watcher = await watching.newPage();
    await watcher.goto(`/spectate/${lobbyId}?e2e=1`);
    // In the room *before* the match starts, or the race is not the one this test is about: the URL
    // holds a lobby id, and a `spectate` that arrives after the lobby has become a match is asking
    // for something that no longer exists. A peer id is the server saying it got there in time.
    await expect.poll(() => watcher.evaluate(() => (window as any).__media.self()), { timeout: 20_000 })
      .toBeTruthy();

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await startCamera(scorer.page);

    // Every viewer linked before a dart lands. A still is sent once, at the moment it is taken, and
    // there is no retry for a peer whose link was still being negotiated — so a spectator who joins
    // late misses that dart, which is honest behaviour and a race this test must not run into.
    await expect
      .poll(() => watcher.evaluate(() => (window as any).__media.links()
        .filter((l: any) => l.kind === 'device' && l.ready).length), { timeout: 30_000 })
      .toBeGreaterThan(0);

    // The strip is there before any picture is — that is the whole point of it having a fixed
    // height, and it is asserted before a dart is thrown rather than after.
    await expect(host.getByTestId('dart-evidence')).toBeVisible({ timeout: 20_000 });
    expect(await evidenceImages(host).count()).toBe(0);
    const before = await slotRowTop(host);

    // A real inference on the board photograph: three darts land in Alice's visit at once, which is
    // also the burst the device's request queue exists for.
    await showScene(scorer.page, 'darts');
    await scan(scorer.page);
    await expect(host.getByText('Visit: 140')).toBeVisible({ timeout: 20_000 });

    // Alice threw, so Alice's frontend asked — and addressed the answer to all three roles. Bob and
    // the spectator asked nobody and get the same pictures anyway, which is the point: an observer's
    // copy of what a dart did cannot drift from the thrower's.
    await expect.poll(() => evidenceImages(host).count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => evidenceImages(guest).count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => evidenceImages(watcher).count(), { timeout: 20_000 }).toBeGreaterThan(0);

    // A real JPEG at the configured size, decoded by the browser rather than merely delivered.
    // Asked of the defaults rather than of a literal: this run has no settings file, so they are
    // what the server shipped, and the question is whether what arrives matches what was asked for.
    const decoded = await evidenceImages(host).first().evaluate((img: HTMLImageElement) =>
      img.decode().then(() => ({ w: img.naturalWidth, h: img.naturalHeight })));
    expect(decoded).toEqual({ w: CONFIG_DEFAULTS.media.still.size, h: CONFIG_DEFAULTS.media.still.size });

    // And the screen did not move when the pictures arrived, which is the rule the fixed height is
    // there to keep.
    expect(await slotRowTop(host)).toBe(before);

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
    await startCamera(scorer.page);

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

  test('a camera answers its owner and ignores everybody else', async ({ browser }) => {
    const { alice, bob, host, guest } = await onlineMatch(browser);
    const scorer = await openScorer(browser);
    await pairAndNominate(host, scorer.page, 'Alice board');

    await host.click('text=Start Match');
    await host.waitForURL('**/match/**');
    await guest.waitForURL('**/match/**');
    await startCamera(scorer.page);
    await showScene(scorer.page, 'darts');
    await scan(scorer.page);

    // Bob can see Alice's camera — that link is the whole reason he sees her board — and asks it
    // directly, straight down the link, bypassing anything the interface would or would not offer.
    const cameraPeer = await guest.evaluate(() =>
      (window as any).__media.links().find((l: any) => l.kind === 'device'));
    expect(cameraPeer, 'the opponent should be linked to the board camera').toBeTruthy();
    expect(cameraPeer.own, 'and it is not his').toBe(false);

    await guest.evaluate((peerId) => (window as any).__media.sendControl(peerId, {
      kind: 'still_request', id: 'from-the-opponent', tag: { dart: 0 },
    }), cameraPeer.peerId);

    // Silence. Not a refusal — a peer with no business asking learns nothing from an answer.
    await guest.waitForTimeout(3000);
    const answers = await guest.evaluate(() => (window as any).__media.inbox().control
      .filter((m: any) => m.data?.id === 'from-the-opponent'));
    expect(answers).toEqual([]);

    await alice.close();
    await bob.close();
    await scorer.context.close();
  });
});
