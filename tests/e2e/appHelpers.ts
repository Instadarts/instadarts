// What the e2e specs do to the app, rather than what they assert about it.
//
// Board clicks are here because a dart is a position, not a button: every spec that scores has to
// know where T20 is. The rest is the setup each spec would otherwise repeat — a local match with
// two players, a leg played to a win, a visit submitted and waited for.
//
// Not a spec file: Playwright only collects `*.spec.ts`, so this is imported, never run.

import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Tell a scoring device it has already been set up, before it loads.
 *
 * A freshly paired phone opens on onboarding rather than on the scoring screen, which is right for
 * a person and wrong for the six specs that pair one to test something else entirely.
 *
 * Seeded into storage rather than clicked through, for two reasons. It costs no page reload — the
 * Skip button leaves by reloading, which every one of those specs would then have to wait out. And
 * it keeps specs about power management or media links from failing the day somebody renames a
 * button on a screen they do not care about. The real Skip button is covered by
 * `scorer-onboarding.spec.ts`, where it is the thing under test.
 *
 * Merged rather than assigned: a spec that seeds its own settings must not have them thrown away.
 */
export async function skipOnboarding(context: BrowserContext) {
  await context.addInitScript(() => {
    const KEY = 'instadarts_scorer_settings';
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      localStorage.setItem(KEY, JSON.stringify({ ...stored, didOnboard: true }));
    } catch {
      // An opaque origin (about:blank) has no storage to seed. The next navigation has.
    }
  });
}

/** The short code shown inside the frontend's scoring-device pairing dialog. */
export function pairingCode(page: Page): Locator {
  return page
    .getByRole('dialog', { name: 'Pair scoring device' })
    .getByText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
}

/** The device-name field inside the paired scorer's settings menu. */
export function scorerDeviceName(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Device name' });
}

/** Open the paired scorer's settings menu and return its device-name field. */
export async function openScorerSettings(page: Page): Promise<Locator> {
  const name = scorerDeviceName(page);
  if (await name.isVisible().catch(() => false)) return name;
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(name).toBeVisible();
  return name;
}

/** Close the paired scorer's settings menu when it is open. */
export async function closeScorerSettings(page: Page): Promise<void> {
  const name = scorerDeviceName(page);
  if (!await name.isVisible().catch(() => false)) return;
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(name).toHaveCount(0);
}

/** Browser-resolved geometry and presentation of one square camera preview. */
export async function cameraPreviewPresentation(video: Locator) {
  return video.evaluate((element: HTMLVideoElement) => {
    const viewport = element.parentElement;
    if (!viewport) throw new Error('camera preview has no viewport');
    const videoRect = element.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const style = getComputedStyle(element);
    const viewportStyle = getComputedStyle(viewport);
    const viewportBorderWidth = Number.parseFloat(viewportStyle.borderLeftWidth)
      + Number.parseFloat(viewportStyle.borderRightWidth);
    const viewportBorderHeight = Number.parseFloat(viewportStyle.borderTopWidth)
      + Number.parseFloat(viewportStyle.borderBottomWidth);
    return {
      sourceWidth: element.videoWidth,
      sourceHeight: element.videoHeight,
      viewportWidth: viewportRect.width,
      viewportHeight: viewportRect.height,
      viewportInnerWidth: viewportRect.width - viewportBorderWidth,
      viewportInnerHeight: viewportRect.height - viewportBorderHeight,
      videoWidth: videoRect.width,
      videoHeight: videoRect.height,
      objectFit: style.objectFit,
      objectPosition: style.objectPosition,
      position: style.position,
    };
  });
}

/** Rename a paired scorer through its settings menu, then return to the scoring view. */
export async function renameScorerDevice(page: Page, value: string): Promise<void> {
  const name = await openScorerSettings(page);
  await name.fill(value);
  await name.blur();
  await expect(name).toHaveValue(value);
  await closeScorerSettings(page);
}

/** Frontend controls for one named scoring device in the camera menu. */
export function scoringDeviceControls(page: Page, name: string): Locator {
  return page.getByRole('group', { name: `Scoring device: ${name}` });
}

/** Put either a native or ARIA `role="switch"` control into a given state. */
export async function setSwitch(target: Locator, on: boolean): Promise<void> {
  const native = await target.evaluate((element) => (
    element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
  ));
  if (native) {
    await target.setChecked(on, { force: true });
    if (on) await expect(target).toBeChecked();
    else await expect(target).not.toBeChecked();
    return;
  }

  if ((await target.getAttribute('aria-checked')) === String(on)) return;
  await target.click();
  await expect(target).toHaveAttribute('aria-checked', String(on));
}

/** Start the scorer camera through its header switch and wait until inference can run. */
export async function startScorerCamera(
  page: Page,
  { disarmMotion = true }: { disarmMotion?: boolean } = {},
): Promise<void> {
  const toggle = page.getByRole('switch', {
    name: /^(?:Start camera|Resume camera|Turn camera off)$/,
  });
  await expect(toggle).toBeEnabled({ timeout: 90_000 });
  if (!await toggle.isChecked()) {
    await toggle.evaluate((element) => (element as HTMLInputElement).click());
  }
  await expect(toggle).toBeChecked({ timeout: 90_000 });

  if (disarmMotion) {
    await page.evaluate(() => (
      window as unknown as { __scorer: { motion: { disarm: () => void } } }
    ).__scorer.motion.disarm());
    await expect(page.getByRole('button', { name: 'Scan now' })).toBeEnabled({ timeout: 90_000 });
  } else {
    await expect(page.getByRole('button', { name: 'Stop scanning' })).toBeEnabled({ timeout: 90_000 });
  }
}

/**
 * Click a position on the dartboard SVG.
 * Board coords: [0, 1_000_000], y-up, center [500_000, 500_000].
 * SVG is y-down, so we flip: svgY = 1_000_000 - boardY.
 */
/**
 * Keep to the server's message budget.
 *
 * `rateLimit.ts` gives a session ten messages a second and drops the eleventh. A dropped
 * `add_dart`, `submit_visit` or `start_match` is invisible from the page: the server answers
 * `Rate limit exceeded`, the match screen never draws it, and the press simply did not happen. A
 * person cannot press that fast. A test can, and did — three darts and a submit per visit sat
 * exactly on ten a second once the round-trip sleeps came out of these helpers, and the server log
 * shows it dropping both. Eight, not ten, because the app spends from the same bucket on its own.
 *
 * This is a rate the server documents, not a guess at how long something takes.
 */
const BUDGET_PER_SECOND = 5;
const sentTimes = new WeakMap<Page, number[]>();

async function paced(page: Page): Promise<void> {
  for (;;) {
    const now = Date.now();
    const recent = (sentTimes.get(page) ?? []).filter((at) => now - at < 1000);
    if (recent.length < BUDGET_PER_SECOND) {
      recent.push(now);
      sentTimes.set(page, recent);
      return;
    }
    sentTimes.set(page, recent);
    await page.waitForTimeout(1000 - (now - recent[0]) + 10);
  }
}

/**
 * Enough of the visit to tell one state of it from the next.
 *
 * Deliberately not a dart count. A mode declares its own slot row and Whac-A-Mole's is always a
 * full row whatever has been thrown, so counting slots counts the mode's opinion rather than the
 * visit. What the row *says*, who is throwing, and whether there is a visit on screen at all covers
 * a dart landing, a turn passing, a leg ending and a match finishing alike.
 */
const visitState = (page: Page) => page.evaluate(() => [
  document.querySelector('[data-visit-slots]') ? 'live' : 'gone',
  document.querySelector('[data-player][aria-current="true"]')?.getAttribute('data-player') ?? '-',
  [...document.querySelectorAll('[data-visit-slots] > *')]
    .map((slot) => slot.textContent?.trim() ?? '')
    .join(','),
].join(' '));

export async function clickBoard(page: Page, boardX: number, boardY: number) {
  // Named, not "the first svg on the page": that used to be the board, and then an icon appeared
  // above it in the top bar and every dart in the suite landed on a button instead.
  const svg = page.getByTestId('dartboard');

  // A board that will not take a dart drops the press in silence — `handlePointerDown` returns and
  // there is no dart, no error, and nothing on screen to notice. Whether it will take one is the
  // server's answer arriving over the socket, so wait for that rather than for the board to be
  // visible: measured over eight runs, a board that was not ready is where darts were being lost.
  await expect(svg).toHaveAttribute('data-can-throw', 'true');

  const box = await svg.boundingBox();
  if (!box) throw new Error('dartboard bounding box not found');

  const px = box.width * (boardX / 1_000_000);
  const py = box.height * (1 - boardY / 1_000_000);

  const before = await visitState(page);
  await paced(page);
  await svg.click({ position: { x: px, y: py } });
  // And wait for it to come back, so a dart that does go missing fails here rather than surfacing
  // three assertions later as a score nobody can account for.
  await expect
    .poll(() => visitState(page), { message: 'the board took the press but no dart came back' })
    .not.toBe(before);
}

/** Click T20 (triple ring at top). */
export async function clickT20(page: Page) {
  await clickBoard(page, 500_000, 726_000);
}

/** Click S20 (single area at top). */
export async function clickS20(page: Page) {
  await clickBoard(page, 500_000, 600_000);
}

/** Click D20 (double ring at top). */
export async function clickD20(page: Page) {
  await clickBoard(page, 500_000, 866_000);
}

/** Click T19 (triple 19, slightly clockwise from top). */
export async function clickT19(page: Page) {
  // 19 is at 162° from top? Actually sector order: 20(0°),1(18°),18(36°),4(54°),13(72°),6(90°),10(108°),15(126°),2(144°),17(162°),3(180°),19(198°)
  // 19 is index 11: 11*18 = 198° from top. 
  // x = r * sin(198°), y = C + r * cos(198°)
  const r = 226_000; // triple ring midpoint
  const angle = 198 * Math.PI / 180;
  await clickBoard(page, Math.round(500_000 + r * Math.sin(angle)), Math.round(500_000 + r * Math.cos(angle)));
}

/** Click D12 (double 12). */
export async function clickD12(page: Page) {
  // 12 is index 18: 18*18 = 324° from top → or -36°
  const r = 366_000; // double ring midpoint
  const angle = 324 * Math.PI / 180;
  await clickBoard(page, Math.round(500_000 + r * Math.sin(angle)), Math.round(500_000 + r * Math.cos(angle)));
}

/** Submit the current visit. */
export async function submitVisit(page: Page) {
  const submit = page.locator('button:has-text("Submit Visit")');
  await expect(submit).toBeEnabled({ timeout: 5000 });

  // The visit is committed on the server, and everything after this reads state that comes back
  // from it. This used to be a flat 300ms, which is a guess at a round trip rather than a wait for
  // one: when it ran long the next press landed on the turn before, and the failure surfaced
  // somewhere else entirely as a dart on the wrong player or a leg that never ended.
  const before = await visitState(page);
  await paced(page);
  await submit.click();
  await expect
    .poll(() => visitState(page), { message: 'the visit was submitted but nothing moved on' })
    .not.toBe(before);
}

/** Verify a dart label is visible in the current darts row. */
export async function expectDartLabel(page: Page, label: string) {
  await expect(page.locator(`text=${label}`).first()).toBeVisible();
}

/** Hand the board to Alice if it is not already hers. The rota decides who starts each leg. */
export async function ensureAliceThrows(alice: Page, bob: Page) {
  const card = alice.locator('[data-player="Alice"]');
  await expect(card).toBeVisible();
  if ((await card.getAttribute('aria-current')) !== 'true') await submitVisit(bob);
}

/**
 * Alice wins one leg at 501 — 180, 180, then a 141 checkout — while Bob passes.
 *
 * `bob` is the page playing Bob: the same one in a local match, the opponent's in an online one.
 */
export async function winLegAt501(alice: Page, bob: Page = alice) {
  await ensureAliceThrows(alice, bob);
  await clickT20(alice); await clickT20(alice); await clickT20(alice);   // 180 → 321
  await submitVisit(alice);
  await submitVisit(bob);
  await clickT20(alice); await clickT20(alice); await clickT20(alice);   // 180 → 141
  await submitVisit(alice);
  await submitVisit(bob);
  await clickT20(alice); await clickT19(alice); await clickD12(alice);   // 141 → checkout
  await submitVisit(alice);
}

/** Set a match-format field in the lobby, and wait for the server to confirm it. */
export async function setFormat(page: Page, label: string, value: number) {
  const field = page.getByLabel(label);
  await field.fill(String(value));
  await expect(field).toHaveValue(String(value));
}

/** Start a local match with given player names and settings. */
export async function setupLocalMatch(page: Page, players: string[], startScore = 501) {
  await page.goto('/');
  await page.click('text=Local Match');

  // Add players
  for (const name of players) {
    await page.getByRole('textbox', { name: 'New player', exact: true }).fill(name);
    await paced(page);
    await page.click('button:has-text("Add")');
    await expect(page.locator(`text=${name}`)).toBeVisible();
  }

  // Configure settings
  await page.getByLabel('Starting Score').selectOption(String(startScore));
  // Uncheck double-in (default off), ensure double-out is checked
  const diCheckbox = page.getByRole('checkbox', { name: 'Double In' });
  const doCheckbox = page.getByRole('checkbox', { name: 'Double Out' });
  if (await diCheckbox.isChecked()) await diCheckbox.uncheck();
  if (!await doCheckbox.isChecked()) await doCheckbox.check();

  // Start match
  await paced(page);
  await page.click('text=Start Match');
  await page.waitForURL('**/match/**');
  await expect(page.locator(`text=${startScore}`).first()).toBeVisible();
}

// ============================================================
// Tests
// ============================================================
