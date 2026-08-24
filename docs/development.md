# Working on this app

Practical notes: how to run things, what the traps are, and the mistakes that have actually been
made here. Not a tour of the architecture — for that read the [glossary](./glossary.md),
[user-interface architecture](./ui.md) and [game modes](./game-modes.md).

## Where things live

Three trees. `shared/` is the only one both of the others may import, and it holds no I/O.

```
src/shared/     types.ts        the match, the visit, the mode's view of both — the wire's vocabulary
                protocol.ts     every message, in both directions, and the parse/format pair
                config.ts       every knob a deployment may turn, and its default
                settings.ts     how a setting declares itself, and how to read one out of the bag
                matchFormat.ts  sets and legs: standings, the winner, whose throw it is
                scoring.ts      board coordinates → a dart's score. The one authority on what was hit
                vision/         geometry and constants the camera pipeline shares with the server

src/server/     index.ts        boot: modes, express, the socket server, the clocks
                wsHandler.ts    routing, and the gameplay handlers — lobby, match, re-match, spectate
                connections.ts  who is connected, how to address them, and who they may play for
                scoringDevices.ts  the pairing and camera-report handlers
                store.ts        lobbies and matches in memory, and the only place either is created
                seats.ts        a place in a room and the token that proves it, for reconnecting
                match.ts        the match layer: a leg's context, and a won leg becoming a won match
                modes/          one file per game mode, listed in registry.ts
                scoring/        turning camera reports into darts: throw windows, clustering, fusion
                devices.ts      the pairing registry: which phone belongs to which browser
                media.ts        who may open a peer connection to whom, and the relay that lets them
                validation.ts   everything arriving from a client, checked before it is believed
                lifecycle.ts    deadlines — the idle timeout and the summary clock, and the
                                only thing that deletes a lobby or a match
                capacity.ts     how big this server may get, all of it derived from one number
                config.ts       the optional settings file: where it is, and what a bad one does
                rateLimit.ts, env.ts, invite.ts, player.ts

src/client/     App.tsx         routes, and the one hook that holds match state
                ScorerApp.tsx   the scoring device's app — a sibling of App, not a route inside it
                pages/          a screen each; pages/scorer/ is the phone's
                components/     shared cards/icons plus the match screen's parts, board, top bar
                layout/         Mantine theme, RGL page grids/defaults, layout editor, app zoom
                modes/          a mode's optional panel component, found by filename
                hooks/          the socket, the match, the vision runtime, paired devices
                lib/            storage, power, the settings the server sent (appConfig.ts)
                vision/         the camera, the model, the motion gate, the geometry
                media/          peer connections between the devices in a match
```

The two rules worth knowing before moving anything: **the client holds no game rules** — every
mode-specific value is computed on the server and shipped in `ModeView` — and **a game mode knows
nothing about matches, sockets or sets**. See [game modes](./game-modes.md) for both.

## Running it

```sh
npm run dev     # the API/WebSocket server on 3000 and Vite on 5173, together
npm test        # unit tests (vitest). A couple of seconds; run them freely
npm run test:e2e  # the whole browser suite; model/media projects make it a longer check
npm run build   # production build — and see the warning below
```

### Settings

**One optional file, and no environment variables.** Copy
[`instadarts.config.example.jsonc`](../instadarts.config.example.jsonc) to `instadarts.config.jsonc`
and edit it; with no file at all, the defaults are the deployment. It is looked for in the working
directory and beside the running executable, and `INSTADARTS_CONFIG=/path/to/file` overrides both —
that variable locates the file and sets nothing in it, which is what lets a second instance run
beside a first. `INSTADARTS_DIR` names a directory to look in rather than a file, and is what the
release bundle sets so the settings can sit beside the executable.

Test processes do not inspect the working directory or executable directory for settings. Unit and
browser tests therefore run against defaults unless the harness explicitly supplies a fixture with
`INSTADARTS_CONFIG` or `INSTADARTS_DIR`; a developer's local deployment file cannot affect them.

**The example holds every knob at its default**, so a copy of it changes nothing and the file shows
its own shape rather than describing it. The cost is that a copy *pins* those values: a setting left
in place keeps today's number even if a later version picks a better one, and only a setting deleted
follows the default onwards. So deleting is the right way to say "no opinion", which is a large part
of why a trailing comma has to be survivable. `tests/unit/config.test.ts` reads the example through
the real loader and requires it to equal `CONFIG_DEFAULTS` exactly, so the file cannot drift from the
code without a test saying so.

**`.jsonc`, because that is what it is**: JSON with comments, which a file named `.json` would be
telling an editor it is not. `instadarts.config.json` is accepted too — someone who renames it has
not made a mistake. Comments are stripped before parsing, and so is a comma left dangling before a
`}` or `]`, which is exactly what deleting the last setting in a section leaves behind. Strings
are respected by both passes, so a `//` inside an ICE url survives.

The knobs and their defaults are declared once in
[`shared/config.ts`](../src/shared/config.ts); [`server/config.ts`](../src/server/config.ts) reads
the file over them. Four sections, split by whose knob it is:

| | |
| --- | --- |
| `server` | `port`, `maxMatches`, `maxPlayersPerMatch` — never leaves the process |
| `frontend` | ⏳ nothing yet; the section exists so the first one has a home |
| `scorer` | `cameraFrameRate` |
| `media` | `enabled`, `iceUrls`, `stunPort`, `setupTimeoutMs`, `still.size`, `video.{size,frameRate,bitrate}`, `virtualCamera.{transitionMs,resetMs}`, `dartEvidence.{regionSize,transitionMs,resetMs}` |

Three of the four are needed by code running in a browser, which has no file to read — so the server
sends a client its share as **`app_config`**, on connect, next to `mode_catalog`. The `server`
section is not in it. On the client, that lands in
[`lib/appConfig.ts`](../src/client/lib/appConfig.ts), which is a module-level store rather than React
state because the readers are not all React: the vision runtime, the camera and the still capture are
plain modules built once.

Nothing a user can change from the app's own screens belongs here — those are per-device settings and
live in that screen's storage.

The frontend and scorer presentation zoom controls are also local browser preferences, not
deployment settings. Match layout positions are frontend-local preferences too. Their ownership,
validation and reset behavior are documented in [ui.md](./ui.md#match-layout-editing-and-persistence).

A value of the wrong type or out of range is ignored, the default stands, and it says which one on
the way past; an unrecognised key is named for the same reason. A file that cannot be parsed at all
stops the server with one line and no stack, quoting the line it gave up on — a deployment that
believes it is configured and is not is worse than one that will not start.

```sh
curl -s 'http://[::1]:3000/server-stats'   # the derived limits, and what is held against them
```

`maxMatches` is the only capacity number a deployment sets; everything the server refuses or evicts
by is derived from it in [`capacity.ts`](../src/server/capacity.ts).

Media is peer-to-peer video between the devices in a match, and `media.enabled` turns it off in the
strongest sense: the server mints no peer ids, publishes no rosters and relays nothing, and neither
frontend shows a thing. `iceUrls` decides how two devices behind different routers find each other,
and defaults to `["internal"]` — the STUN server this deployment carries itself, on `stunPort`, so
that making remote play work does not mean naming a third party. It needs that UDP port reachable,
which a reverse proxy will not arrange. There is still no TURN, so where a connection cannot be made
the feature is simply unavailable. See [media.md](./media.md).

What is *not* in the file is whether this is a development or a production build. That is `NODE_ENV`,
decided when the program is built, and it stays an environment variable because it is already true by
the time a file could be read. `QUIET` and `CLIENT_DIR` are the same kind of thing — properties of
the run rather than of the deployment — and are what is left in
[`env.ts`](../src/server/env.ts). `INSTADARTS_CONFIG` and `INSTADARTS_DIR` are not settings at all:
they say where to look for the file, and set nothing in it.

### Connections that vanish without closing

A phone whose radio drops sends no FIN, so its socket, its client record and its device claim would
otherwise sit there until TCP keepalive gives up — a little over two hours on Linux.
[`heartbeat.ts`](../src/server/heartbeat.ts) pings every 30 s and cuts anything that missed the last
round, so the worst case is about a minute. It cuts with `terminate()`, which fires the socket's
ordinary `close`, so everything that already happens on a disconnect still happens.

It is the backstop, not the main path: a scoring device that powers itself down closes cleanly and
frees its slot at once.

## How a scoring device manages its own power

Two timers, in [`lib/scorerPower.ts`](../src/client/lib/scorerPower.ts), and nothing else:

```
short timer   runs while   !scoring        fires → camera and motion detector off
long timer    runs while   !cameraActive   fires → wake lock released, socket closed
```

Both reset on a touch, a key, or a command from the owner. The defaults are 2 and 30 minutes,
settable on the device between 1–10 and 10–600.

`scoring` is a field on `scorer_state`, and it is the server's own answer to "would I accept this
device's tips" — `resolveScoringTarget`, the same call that gates the tips themselves. That is what
makes a match starting, a match ending, a re-match, being unclaimed and being claimed mid-match all
one condition rather than five rules. The one push that must not be missed is `handleStartMatch`'s:
a camera that powered down has nothing else to bring it back.

**Losing the socket is deliberately not one of them.** The device keeps the last `scorer_state` it
was told across a disconnect rather than clearing it — see the third point below.

Three things worth knowing before changing any of it:

- **A stage never starts a camera.** Stages only power things down. Coming back is a scoring context
  arriving or a person pressing something — otherwise the touch that resets the timers would turn the
  camera back on the instant somebody pressed "Off".
- **The camera is started on the *edge* of a match beginning**, not whenever one is running, so
  turning it off mid-match sticks.
- **A reconnect is not a match start.** `scoring` alone cannot tell them apart: a socket that drops
  and comes back makes it go false and true again, and reading that edge as a match beginning
  restarts a camera the owner had just switched off. So `scorer_state` also carries
  **`scoringContextId`** — an opaque hash of the match and the board, stable across reconnects and
  different for a new match, a re-match or another player's board — and
  [`lib/scorerReconnect.ts`](../src/client/lib/scorerReconnect.ts) classifies each fresh state as
  `started` or `resumed` against it. Only a `started` brings a camera back on its own; a `resumed`
  restarts one only if this device's own timer was what stopped it.

The e2e suite drives the delays down through `?e2e=1&graceMs=…&standbyMs=…`
([`lib/e2e.ts`](../src/client/lib/e2e.ts)), which does nothing in a shipped build. What it cannot
reach is in [vision.md](vision.md#power-management).

### `npm run build` typechecks both sides

It is `vite build && tsc -p tsconfig.client.json --noEmit && tsc -p tsconfig.server.json --noEmit`.
Vite itself transpiles the client with esbuild and does not typecheck it; the explicit client `tsc`
step after the bundle is what makes a green production build cover DOM and WebGPU types too. To run
that check without building:

```sh
npx tsc -p tsconfig.client.json --noEmit
```

Note the `-p tsconfig.client.json`: only that one adds the DOM and WebGPU libs and Vite's client
types, so pointing `tsc` at the root `tsconfig.json` instead produces a screenful of missing
`GPUBufferUsage`, `import.meta.env` and `import.meta.glob` and tells you nothing.

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

### Why the expensive specs run after the app suite

`media-codec.spec.ts` encodes real H.264 in software, `media-stills.spec.ts` drives the detection
model, and `media-video.spec.ts` does both at once. `playwright.config.ts` puts all three in a
`heavy` project that starts only after the ordinary `app` project finishes. They may run beside one
another inside that project. `scorer-onboarding.spec.ts` then gets a one-file `onboarding` project
after `heavy`, because a project containing one file is the reliable way to make that particularly
expensive self-test run alone.

### Multi-context specs

A user is a browser context, so a match of n users is n of them in one test. `nplayers.spec.ts` runs
three, which is the same weight as `home.spec.ts`; `media-link.spec.ts` already ran four. Contexts
are the CPU lever this section is about, so add them for a property that genuinely needs another
user, and reuse the smallest arrangement that contains it.

The `count-up` mode is what several of those specs use: it has no rules to work around, and it is
installed only in development builds and under the test runner — see
[docs/game-modes.md](./game-modes.md#the-development-only-mode). It shows up in the lobby's mode list
when you `npm run dev`, and not on a deployed server. Every shipped mode takes any number of players
now, so a spec that wants the shape a person actually plays should use one of those instead.

**A spec that needs a lobby that fills has to fill it**, at five: no shipped mode narrows the
deployment cap any more, and a specs's host can hold the whole roster itself, so this costs no extra
browser context. `home.spec.ts` does exactly that. Unit tests that want a *mode's* cap register one
for the purpose — see [game-modes.md](./game-modes.md#limiting-the-player-count).

**Starving the suite of CPU is how intermittent failures get made, and not hypothetically.** A page
that misses a heartbeat under load is cut by the server, and a scoring device that reconnects then
walks the whole path this app takes most seriously — see `scoringContextId` above. The symptom lands
in whichever spec happened to be running, never in the one that caused it, which is why isolating the
expensive specs is worth a `dependencies` edge rather than a comment asking people to be careful.

**Worker count is not the lever.** The suite has failed at eight workers and passed at thirteen; what
matters is which files happen to overlap, not how many run at once. If this reappears, look for a new
CPU-heavy spec rather than reaching for `--workers`.

**Keep spec files small, because Playwright parallelises per file.** Tests inside one file run
serially in a single worker, so a spec that grows to hold everything runs alone however many cores
are free. Shared setup goes in [`appHelpers.ts`](../tests/e2e/appHelpers.ts), which is imported and
never collected: Playwright only runs `*.spec.ts`.

If a run fails with `EADDRINUSE` instead of reusing what is already up, something is on the port that
the readiness probe cannot see. `curl -s -o /dev/null -w '%{http_code}' 'http://[::1]:3000/server-stats'`
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

### The e2e server leaves nothing behind, and how

The same wrapper problem reached the test suite. `playwright.config.ts` used to start the server as
`npx tsx src/server/index.ts`, and `tsx` there is a launcher: it spawns a **child** `node` and that
child is what listens on 3000. Playwright stops only the process it started, so the child survived
every run and sat on the port, and the next run met `EADDRINUSE` from a server nobody could see.

It is now `node --import tsx/esm src/server/index.ts` — the loader is registered inside one process,
so the thing Playwright starts is the thing that listens and the thing that dies. `npm start` was
already written this way; the config now matches it.

Worth remembering whenever a `webServer` command is changed: **the command must be the listener, not
a launcher for it.**

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
(1600×800 — the one that catches layouts which only work on tall screens), and 2560×1440. For RGL
work, also check immediately below and above 480, 768, 996 and 1200 px **container** widths; root
presentation zoom means the viewport width alone is not always the active breakpoint.

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
- **Structure-coupled selectors break on markup changes and valid grid movement.** Locate an outer
  box with `[data-grid-item="scores"]` (or another stable item id), then use roles, labels,
  `data-player` or a functional test id inside it. Do not encode RGL transforms, DOM depth, sibling
  order or a canonical `x`/`y` unless the layout itself is under test.
- **Assertions on mode-provided strings go stale when a mode changes.** Changing an x01 dart slot
  from `T20 (60)` to `T20` and blanking the panel title broke three tests that had nothing to do
  with the change. If you edit `src/server/modes/*.ts`, grep the specs — unit *and* e2e — for the
  strings you touched.
- **`getByText` needs the text to be visible; a `data-testid` does not.** Some text on the scoring
  device is rendered but hidden, so `expect(page.getByText('Ready — no match running')).toBeVisible()`
  fails on a page that is working perfectly. `expect(page.getByTestId('scorer-status')).toHaveText(…)`
  reads the same state without caring whether it is shown — which is what the pairing and inference
  specs do.
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
