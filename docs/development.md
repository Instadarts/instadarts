# Working on this app

How to run, configure, build, and test the app, including common contributor pitfalls. For the
architecture, read the [glossary](./glossary.md),
[match lifecycle](./match-lifecycle.md), [user-interface architecture](./ui.md), and
[game modes](./game-modes.md).

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

src/server/     index.ts        boot: modes, the HTTP router, the socket server, the clocks
                staticServing.ts  the built client, from the embedded bundle or from disk — one
                                set of rules over both, including the one that refuses to leave
                                the client directory
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
                config.ts       settings-file discovery, parsing and validation
                rateLimit.ts    burst and sustained-rate budgets, and the clients that exhaust them
                env.ts, invite.ts, player.ts, listenUrls.ts, start.ts

src/client/     App.tsx         routes, and the one hook that holds match state
                ScorerApp.tsx   the scoring device's app — a sibling of App, not a route inside it
                pages/          a screen each; pages/scorer/ is the phone's
                components/     shared cards/icons plus the match screen's parts, board, top bar
                layout/         the palette and Mantine theme, RGL page grids/defaults, the layout
                                editor, app zoom and the bright/dark preference
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
npm run build   # production build and all typechecks
npm start       # run that build: one process, serving the client itself
```

`npm start` sets `NODE_ENV=production` from [`start.ts`](../src/server/start.ts) rather than from
the script line, which a Windows Command Prompt would not honour. It prints the addresses it is
listening on — the real ones, because a `localhost` URL is no use to the phone that has to reach it.

The production build also generates `dist/client/THIRD-PARTY-NOTICES.txt`. In production the server
exposes that file as plain text at `/THIRD-PARTY-NOTICES.txt`, and both settings menus link to it in
a new tab. Development menus omit the link because Vite does not serve the generated production
file.

### Releases

**Releases contain source only.** GitHub attaches `Source code` archives to every tag, and those
archives are all the project publishes. A downloader runs `npm install`, `npm run build`, and then
`npm start`. The workflow verifies the tagged commit with `npm ci`, `npm audit`, `npm test`, and
`npm run build`. Generated output and installed dependencies are neither committed nor attached to
the release.

The audit is `npm audit --audit-level=info`, and it is a step of its own because `npm ci` reports
its advisory count and exits 0 whatever that count is. Every severity, and devDependencies
included: a downloader builds the source themselves, so the dev half of the tree is code that runs
on their machine rather than build-only noise. It is checked against the registry as it stands at
release time, which means **a tag can fail on an advisory published long after the code was
merged.** That is the intent — the question is whether this is safe to hand out today — but it does
mean a release can be blocked by something no code change caused. Where the advisory has no fix,
`--audit-level=high` narrows it to the serious ones.

The version the home page stamps in the corner of its title card is the same number and comes from
the same place: Vite substitutes `__APP_VERSION__` from `package.json` at build time, declared in
[`env.d.ts`](../src/client/env.d.ts) and read through
[`lib/version.ts`](../src/client/lib/version.ts). Nothing reports it at runtime and the server does
not know it — a release is the source, so the bundle and the server it talks to are built from one
snapshot and there is nothing a round trip could add.

`bash scripts/build-mjs.sh [version]` remains the optional single-file build, for handing somebody
one file to run with no npm involved. It embeds the client and inlines the server dependencies into
`instadarts.mjs`, so that archive *does* redistribute other people's code and carries the full
notice — both beside the program and inside it, from the same generated file.

### Settings

**One optional settings file; its environment variables only locate it.** Copy
[`instadarts.config.example.jsonc`](../instadarts.config.example.jsonc) to `instadarts.config.jsonc`
and edit it; with no file at all, the defaults are the deployment. It is looked for in the working
directory and beside the running executable, and `INSTADARTS_CONFIG=/path/to/file` overrides both —
that variable locates the file and sets nothing in it, which is what lets a second instance run
beside a first. `INSTADARTS_DIR` names a directory to look in rather than a file, and is what the
standalone `.mjs` bundle sets so the settings can sit beside the executable.

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
are respected by both passes, so a `//` inside an ICE URL survives.

The knobs and their defaults are declared once in
[`shared/config.ts`](../src/shared/config.ts); [`server/config.ts`](../src/server/config.ts) reads
the file over them. Four sections, split by whose knob it is:

| | |
| --- | --- |
| `server` | `port`, `maxMatches`, `maxPlayersPerMatch` — never leaves the process |
| `frontend` | reserved and currently empty |
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

### Serving the client

[`staticServing.ts`](../src/server/staticServing.ts) answers everything that is not `/server-stats`
or a WebSocket upgrade, from one of two sources: the assets embedded in `instadarts.mjs`, or
`dist/client` on disk. **A browser must not be able to tell which.** Every rule about *what* to
answer is shared; only the reading of the bytes differs, and the two are tested through the same
socket-level harness in `staticServing.test.ts` and `staticServingDisk.test.ts`. Where those two
files disagree, one of the two deployments is wrong.

The rules:

- **A path with a file extension is asking for a file.** If it is not there, that is a 404 — not
  the application. Answering `/assets/missing.js` with `index.html` hands the browser a script that
  is not one, and it reports the parse error instead of the 404 that actually happened. Anything
  *without* an extension is a client-side route and gets the application.
- **Only `/assets/` is immutable.** The bundler puts a content hash in those filenames, so a cached
  copy can never be the wrong one. `/wasm/` and `/models/` are copied in under fixed names, where a
  year-long cache would leave a browser holding the previous release's runtime — so they
  revalidate, and an ETag turns that into a 304.
- **Every client response carries all three cross-origin isolation headers**, because LiteRT's
  multithreaded WASM needs `SharedArrayBuffer` and losing any one of them costs it. `/server-stats`
  does not carry them and does not need them.
- **A path is resolved and then checked to still be inside the client directory**, after decoding.
  That order is the only one that catches an escape spelled `%2e%2e`.

There is no HTTP framework here. The server is `node:http` with a router small enough to read in
one screen at the bottom of [`index.ts`](../src/server/index.ts), which is what keeps the runtime
dependencies at `ws` and `tsx`.

## Build and typechecking

It builds with Vite, typechecks the client, the server and everything else, and then generates the
third-party notices from the browser dependency closure. Vite itself transpiles the client with
esbuild and does not typecheck it; the explicit `tsc` steps after the bundle are what make a green
production build mean something. To run them without building:

```sh
npx tsc -p tsconfig.client.json --noEmit
npx tsc -p tsconfig.server.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
```

**Always name a project.** `tsconfig.json` is a base to be extended and nothing else — it carries no
`types` and no DOM lib, so pointing `tsc` at it produces a screenful of missing `GPUBufferUsage`,
`import.meta.env` and `import.meta.glob` and tells you nothing.

`tsconfig.node.json` covers what the client and server projects do not: `vite.config.ts`,
the Vitest and Playwright configs, `scripts/`, and all of `tests/`. It includes Vite, WebGPU, and
Node types because those files also import client source.

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

Several specs use the development-only `count-up` mode for simple additive scoring. Use a production
mode when the test is intended to represent production behavior.

**A spec that needs a lobby that fills has to fill it**, at five: no current mode narrows the
deployment cap, and a spec's host can hold the whole roster itself, so this costs no extra
browser context. `home.spec.ts` does exactly that. Unit tests that want a *mode's* cap register one
for the purpose — see [game-modes.md](./game-modes.md#limiting-the-player-count).

CPU starvation can delay a page past the server heartbeat and cause failures in a different spec
from the one consuming the resources. Put new CPU-heavy specs in the appropriate ordered project;
changing the worker count does not guarantee that expensive files stop overlapping.

**Keep spec files small, because Playwright parallelises per file.** Tests inside one file run
serially in a single worker, so a spec that grows to hold everything runs alone however many cores
are free. Shared setup goes in [`appHelpers.ts`](../tests/e2e/appHelpers.ts), which is imported and
never collected: Playwright only runs `*.spec.ts`.

## Process cleanup

`npm run dev` is `concurrently -k "tsx watch src/server/index.ts" "vite"` — a small tree, not one
process. After an interrupted run, use the operating system's process manager to stop the entire
development-server process tree rather than only the processes holding ports 3000 and 5173.

Playwright starts the API with `node --import tsx/esm src/server/index.ts`, so the process it owns is
also the listener it stops. Preserve that property when changing a `webServer` command: the command
must be the listener, not a launcher that leaves a child behind.

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

When checking responsive behavior:

- **Faint rectangles and edges in a downscaled screenshot are usually artifacts.** Before chasing
  one, ask the page what is actually there: `document.elementFromPoint(x, y)` and walk up
  `parentElement` printing `className` and `getComputedStyle(el).backgroundColor`.
- **State round-trips through the server.** Clicking three darts and reading the slots immediately
  shows two, because the third has not come back over the WebSocket yet. Wait for the effect you
  expect (`expect.poll`, or a plain `waitForTimeout` in a throwaway spec) rather than concluding the
  click was dropped. The board answers the other half of that question itself: `data-can-throw` on
  `[data-testid="dartboard"]` is whether a dart thrown *now* would be taken, and a press it will not
  take is dropped in silence — no dart, no error, nothing to see. `clickBoard` waits for it.
- **Floating elements resize and reposition asynchronously.** Close dropdowns before changing the
  viewport, reopen them at the target size, and use a polled assertion when measuring them.

## Tests that do not break for the wrong reason

Common selector and synchronization constraints:

- **`text=` is substring and case-insensitive.** `text=0S` matched the panel's always-visible `180s`
  label. Scope to an element and anchor the pattern: `page.locator('[data-player="Alice"]')` plus
  `/^\d+[SL]$/`.
- **Structure-coupled selectors break on markup changes and valid grid movement.** Locate an outer
  box with `[data-grid-item="scores"]` (or another stable item id), then use roles, labels,
  `data-player` or a functional test id inside it. Do not encode RGL transforms, DOM depth, sibling
  order or a canonical `x`/`y` unless the layout itself is under test.
- **A message the server refuses is not always a message the screen mentions.** Several handlers
  return without answering — `start_match` from a connection holding no seat is one — and a
  `Rate limit exceeded` reply is not drawn on the match screen at all. The symptom is a press that
  does nothing, for as long as you care to wait, with no error anywhere: it looks like a dead button
  or a broken selector, and it is neither. Before chasing the UI, log inbound messages on the server
  and see whether the press arrived and what was done with it.
- **Assertions on mode-provided strings follow the mode contract.** If you edit
  `src/server/modes/*.ts`, search the unit and end-to-end specs for the strings you changed.
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

**Run the full e2e suite before saying it passes.** Targeted runs are for iteration; report the
whole suite only after running the whole suite.

**Do not filter output when reporting a test result.** A filter can hide the summary and make the
shell report the filter's exit status instead of the test runner's. Run the test command directly
when deciding whether it passed.

**Attribute a failure before fixing it.** Reproduce a surprising failure against a clean `HEAD`,
preferably in a temporary worktree, before assuming the current change caused it.

**Re-check the mode boundary.** Search `src/` for `startScore`, `doubleIn`, `doubleOut`, and `bust`
outside `src/server/modes/x01.ts`. Every result should be a comment or the dartboard's physical ring
radii (`doubleOuter`, `doubleInner` in `scoring.ts` and `boardGeometry.ts`, which are millimetres and
not the x01 setting). Anything else is a leak. See [game modes](./game-modes.md) for the boundary.

## Two things about the board that are easy to get wrong

**There are two coordinate systems.** Board units (0–1,000,000, y-up, centre at 500,000) are the wire
— a dart's `x`/`y`, the scoring rules, the camera. SVG units (0–100, y-down) are only how the picture
is drawn. `toSvg` and `toBoard` in `boardGeometry.ts` are the only crossings, and there are exactly
two: a marker going in and a click coming out.

The drawing has its own system because of text. **Chrome clamps `font-size` at 10,000**, so in a
million-unit viewBox a readable label is not expressible. Size drawn labels in SVG units; a label of
`4` is about 4% of the board's width at any rendered size. Express physical geometry in millimetres
and multiply it by `MM`, as the ring radii and wire thicknesses do.

**The screen should not jump.** An element is its final size from the first frame, not the size of
what it currently has to show. That rule and what it looks like in practice are written up under
[A screen that does not jump](./game-modes.md#a-screen-that-does-not-jump).
