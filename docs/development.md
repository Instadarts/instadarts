# Working on this app

Practical notes: how to run things, what the traps are, and the mistakes that have actually been
made here. Not a tour of the architecture — for that read the [glossary](./glossary.md) and
[game modes](./game-modes.md).

## Where things live

Three trees. `shared/` is the only one both of the others may import, and it holds no I/O.

```
src/shared/     types.ts        the match, the visit, the mode's view of both — the wire's vocabulary
                protocol.ts     every message, in both directions, and the parse/format pair
                settings.ts     how a setting declares itself, and how to read one out of the bag
                matchFormat.ts  sets and legs: standings, the winner, whose throw it is
                scoring.ts      board coordinates → a dart's score. The one authority on what was hit
                vision/         geometry and constants the camera pipeline shares with the server

src/server/     index.ts        boot: modes, express, the socket server, the clocks
                wsHandler.ts    routing, and the gameplay handlers — lobby, match, re-match, spectate
                connections.ts  who is connected and how to address them; nothing about meaning
                scoringDevices.ts  the pairing and camera-report handlers
                store.ts        lobbies and matches in memory, and the only place either is created
                match.ts        the match layer: a leg's context, and a won leg becoming a won match
                modes/          one file per game mode, found by scanning this directory
                scoring/        turning camera reports into darts: throw windows, clustering, fusion
                devices.ts      the pairing registry: which phone belongs to which browser
                validation.ts   everything arriving from a client, checked before it is believed
                lifecycle.ts    deadlines — the idle timeout and the summary clock, and the
                                only thing that deletes a lobby or a match
                capacity.ts     how big this server may get, all of it derived from one number
                rateLimit.ts, env.ts, invite.ts, player.ts

src/client/     App.tsx         routes, and the one hook that holds match state
                ScorerApp.tsx   the scoring device's app — a sibling of App, not a route inside it
                pages/          a screen each; pages/scorer/ is the phone's
                components/     the match screen's parts, the dartboard, the top bar
                modes/          a mode's optional panel component, found by filename
                hooks/          the socket, the match, the vision runtime, paired devices
                vision/         the camera, the model, the motion gate, the geometry
```

The two rules worth knowing before moving anything: **the client holds no game rules** — every
mode-specific value is computed on the server and shipped in `ModeView` — and **a game mode knows
nothing about matches, sockets or sets**. See [game modes](./game-modes.md) for both.

## Running it

```sh
npm run dev     # the API/WebSocket server on 3000 and Vite on 5173, together
npm test        # unit tests (vitest). A couple of seconds; run them freely
npm run test:e2e  # the whole browser suite. Around twenty seconds
npm run build   # production build — and see the warning below
```

### Scaling the server

`MAX_MATCHES` is the only capacity number a deployment sets; everything the server refuses or evicts
by is derived from it in [`capacity.ts`](../src/server/capacity.ts).

```sh
MAX_MATCHES=50000 npm start     # default is 10000
curl -s 'http://[::1]:3000/server-stats'   # the derived limits, and what is held against them
```

Anything that is not a positive whole number is ignored in favour of the default — a `NaN` there
would make every comparison false and silently disable the limits that divide from it.

### `npm run build` does not typecheck the client

It is `vite build && tsc -p tsconfig.server.json --noEmit`. Vite transpiles the client with esbuild,
which strips types without checking them, and the `tsc` step only covers `src/server` and
`src/shared`. **A green build says nothing about client types.** Check them explicitly:

```sh
npx tsc -p tsconfig.client.json --noEmit
```

Run that after touching anything under `src/client`. Note the `-p tsconfig.client.json`: the root
`tsconfig.json` has no `jsx` setting, so pointing `tsc` at it produces a screenful of `TS17004
Cannot use JSX unless the '--jsx' flag is provided` and tells you nothing.

## The e2e suite

Playwright owns the servers. `playwright.config.ts` declares both of them as `webServer` entries, so
any of these work on their own and start and stop what they need:

```sh
npx playwright test                       # everything
npx playwright test scorer-pairing        # one file (substring of the path)
npx playwright test -g "unpairs itself"   # one test, by title
npx playwright test --grep "Sets and legs"
```

**Do not hand-start a dev server for a test run**, and do not background `npm run dev` and hope. The
two servers are declared separately so each gets its own readiness probe — a Vite that answers says
nothing about whether the socket the first test opens has anyone listening on 3000.

`reuseExistingServer` is on outside CI, so a dev server you already have running is the one the tests
use. That is usually what you want; be aware the tests are then running against your dev server's
state.

**Keep spec files small, because Playwright parallelises per file.** Tests inside one file run
serially in a single worker, so a spec that grows to hold everything runs alone however many cores
are free. Splitting the one big spec into six took the suite from 1m20s on one worker to 20s on
eight — the same 48 tests. Shared setup goes in [`appHelpers.ts`](../tests/e2e/appHelpers.ts), which
is imported and never collected: Playwright only runs `*.spec.ts`.

If a run fails with `EADDRINUSE` instead of reusing what is already up, something is on the port that
the readiness probe cannot see. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/server-stats`
says whether the server is answering, and the next section is the usual culprit.

## Leftover processes

`npm run dev` is `concurrently -k "tsx watch src/server/index.ts" "vite"` — a small tree, not one
process. Killing whatever holds ports 3000 and 5173 kills the leaves and leaves `concurrently` and
`tsx watch` running. They accumulate silently across runs; at one point sixty of them were sitting on
about 3GB of RSS, invisible to any port check because none of them was listening.

An orphaned `tsx watch` is worse than idle: it restarts and grabs port 3000 the moment you edit a
server file, and the next thing you run fails for reasons that have nothing to do with it.

If a run was interrupted, look for the parents, not the ports:

```sh
pgrep -af 'concurrently -k'
pgrep -af 'tsx watch'
```

**`pkill -f` will match its own command line.** `pkill -f 'tsx watch src/server/index.ts'` kills the
shell running it — the pattern appears in that shell's `cmdline`. Either kill by PID after looking,
or build the pattern so it cannot match itself:

```sh
PAT='tsx wa'"tch src/server"; pgrep -f "$PAT"
```

## Checking a UI change

Screenshots, not reasoning about CSS. The fastest loop is a throwaway spec under `tests/e2e/`
(prefix it `zz-` so it sorts last, and delete it when you are done) that drives the app to the state
you care about, resizes the viewport, and both screenshots *and* measures:

```ts
await page.setViewportSize({ width, height });
await page.screenshot({ path: `${OUT}/thing-${label}.png` });
const report = await page.evaluate(() => ({
  board: Math.round(document.querySelector('svg')!.getBoundingClientRect().width),
  scrolls: document.querySelector('main')!.scrollHeight > document.querySelector('main')!.clientHeight,
}));
```

Measure as well as look. "Does it fit" and "did it actually grow" are numbers, and a screenshot
scaled down for viewing will not tell you either. Useful viewports to cover: something narrow
(420×900), the two-column band (1100×950), three columns (1600×1000), a short wide window
(1600×800 — the one that catches layouts which only work on tall screens), and 2560×1440.

Two things that will waste your time:

- **Faint rectangles and edges in a downscaled screenshot are usually artifacts.** Before chasing
  one, ask the page what is actually there: `document.elementFromPoint(x, y)` and walk up
  `parentElement` printing `className` and `getComputedStyle(el).backgroundColor`.
- **State round-trips through the server.** Clicking three darts and reading the slots immediately
  shows two, because the third has not come back over the WebSocket yet. Wait for the effect you
  expect (`expect.poll`, or a plain `waitForTimeout` in a throwaway spec) rather than concluding the
  click was dropped.

## Tests that do not break for the wrong reason

Selector traps that have all actually bitten here:

- **`text=` is substring and case-insensitive.** `text=0S` matched the panel's always-visible `180s`
  label. Scope to an element and anchor the pattern: `page.locator('[data-player="Alice"]')` plus
  `/^\d+[SL]$/`.
- **Structure-coupled selectors break on markup changes.** `div:has(> h3:text("Visit History"))`
  stopped matching when the region became a `<section>`. Prefer a stable hook — the player cards
  carry `data-player` for exactly this reason — or at least do not pin the tag name.
- **Reserved blank rows are still rows.** The visit history draws a fixed number of rows and leaves
  the spare ones blank, so "no visits yet" is about text, not element count. `visitHistoryRows()` in
  `appHelpers.ts` filters to rows that contain a total; count-based assertions would pass on an empty
  screen and fail on a full one.
- **Assertions on mode-provided strings go stale when a mode changes.** Changing an x01 dart slot
  from `T20 (60)` to `T20` and blanking the panel title broke three tests that had nothing to do
  with the change. If you edit `src/server/modes/*.ts`, grep the specs — unit *and* e2e — for the
  strings you touched.
- **Settings checkboxes are echoed by the server, so `check()` fights them.** A lobby toggle is
  controlled by lobby state that arrives over the WebSocket, so it does not flip on click.
  Playwright's `check()` clicks, sees the old value, and clicks again — turning it back off, then
  failing with "Clicking the checkbox did not change its state". Use `click()` and then
  `await expect(box).toBeChecked()`, or guard with `isChecked()` first as `setupLocalMatch` does.

## Habits worth keeping

**Run the full e2e suite before saying it passes.** Running `-g "Game modes"`, seeing green, and
reporting that the tests pass has happened here and was wrong — the change had broken a test in a
different describe block. Targeted runs are for iterating; the full run is what you report.

**Do not pipe a test run through `tail`.** `npm test | tail -3` hides vitest's own summary line, and
worse, the exit status of a pipeline is the *last* command's — so `tail` returns 0 and a `&&` chain
carries on past a red suite. A failing unit test survived two rounds of "all tests pass" that way.
Grep for the summary instead, which keeps the counts and does not pretend to be a status:
`npm test 2>&1 | grep -E 'Test Files|Tests |FAIL'`.

**Attribute a failure before fixing it.** `git stash`, re-run the failing test, `git stash pop`. Two
failures in this session looked like they belonged to the change in progress and turned out to be
pre-existing on `HEAD`. It takes thirty seconds and it changes what you write in the commit message.

**Re-check the mode boundary.** The match layer knows nothing about any game mode's rules, and the
cheapest way to confirm that still holds is:

```sh
grep -rn "startScore\|doubleIn\|doubleOut\|bust" src --include=*.ts --include=*.tsx | grep -v "src/server/modes/x01.ts"
```

Everything it returns should be a comment, or the dartboard's physical ring radii (`doubleOuter`,
`doubleInner` in `scoring.ts` and `boardGeometry.ts`, which are millimetres and not the x01 setting).
Anything else is a leak. See [game modes](./game-modes.md) for what the boundary is.

## Two things about the board that are easy to get wrong

**There are two coordinate systems.** Board units (0–1,000,000, y-up, centre at 500,000) are the wire
— a dart's `x`/`y`, the scoring rules, the camera. SVG units (0–100, y-down) are only how the picture
is drawn. `toSvg` and `toBoard` in `boardGeometry.ts` are the only crossings, and there are exactly
two: a marker going in and a click coming out.

The drawing has its own system because of text. **Chrome clamps `font-size` at 10,000**, so in a
million-unit viewBox a readable label is not expressible — the sector numbers and the digits in the
dart markers were invisible and could not be fixed by asking for a larger size. Anything you add to
the board should be sized in SVG units; a label of `4` is about 4% of the board's width at whatever
size it is currently drawn.

**The screen should not jump.** An element is its final size from the first frame, not the size of
what it currently has to show. That rule and what it looks like in practice are written up under
[A screen that does not jump](./game-modes.md#a-screen-that-does-not-jump).
