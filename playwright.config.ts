import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defineConfig } from '@playwright/test';

const SERVER_PORT = Number(process.env.PORT ?? 3000);

/**
 * A settings file for the run, when the run wants something other than the defaults.
 *
 * The server is tuned by a file rather than by the environment, so a suite that needs a non-default
 * deployment has to write one. Two do:
 *
 *   · `MEDIA=0 npx playwright test` — the whole point of the media flag is that it must be
 *     disable-able, and running the suite with it off is the only way to see that the rest of the
 *     app does not quietly depend on it.
 *   · `PORT=…` — a second instance beside a first.
 *
 * Written to the system temp directory rather than into the repository, so it cannot be mistaken for
 * a deployment's own file and cannot survive into one. When neither is asked for, no file is written
 * at all and the run exercises the same defaults a fresh install would.
 */
function settingsFile(): string | null {
  const settings: Record<string, unknown> = {};
  if (SERVER_PORT !== 3000) settings.server = { port: SERVER_PORT };
  if (process.env.MEDIA === '0') settings.media = { enabled: false };
  if (Object.keys(settings).length === 0) return null;

  const path = join(tmpdir(), `instadarts-e2e-${SERVER_PORT}.config.json`);
  writeFileSync(path, JSON.stringify(settings, null, 2));
  return path;
}

const SETTINGS = settingsFile();

/**
 * The app is one process — the API/WebSocket server, with the Vite dev client mounted inside it —
 * and it is Playwright's to start. `DEV_CLIENT` is what asks for that client; without it the same
 * command is an API server that answers 404 to every page the suite would open.
 *
 * One probe covers both halves. The client is mounted before the server listens, so `/server-stats`
 * answering means the whole app is ready — where two servers used to need a probe each, because a
 * Vite that answered said nothing about whether the socket the first test opens had anyone
 * listening on it.
 *
 * `tsx` without `watch`: a test run has no files changing under it, and a watcher is one more thing
 * to shut down. Which matters, because shutting down is the other half of what this buys — the npm
 * script this replaces killed whatever held the port and left the wrappers above it running.
 *
 * And `node --import tsx/esm` rather than `npx tsx`, for the same reason one level down: the `tsx`
 * CLI is a launcher that spawns a child node, and that child is what listens. Playwright stops the
 * process it started, so the child outlived every run and held port 3000. Registering the loader in
 * one process makes the thing started, the thing listening and the thing killed all the same one.
 */
/**
 * `[::1]` and not `localhost`, which costs four minutes a run on WSL2.
 *
 * Playwright probes the url once *before* starting anything — that is how it decides whether a
 * server is already up — and under WSL2 a connection to a closed port on 127.0.0.1 is not refused
 * but black-holed, so it sits through the full TCP SYN timeout of about 132 seconds. `localhost`
 * resolves to IPv4 first and pays it too. IPv6 loopback is refused immediately, and the server
 * listens on it: Node binds dual-stack by default.
 */
const webServer = {
  command: 'node --import tsx/esm src/server/index.ts',
  url: `http://[::1]:${SERVER_PORT}/server-stats`,
  // Everything the run is, that the deployment is not. NODE_ENV keeps a deployment config in the
  // repository from leaking into the test harness; QUIET and DEV_CLIENT are properties of the run
  // in the same way. Everything the test is explicitly tuned to goes in the file above, when there
  // is one.
  env: {
    NODE_ENV: 'test',
    QUIET: '1',
    DEV_CLIENT: '1',
    ...(SETTINGS ? { INSTADARTS_CONFIG: SETTINGS } : {}),
  },
  // A dev server already up is the one to test against; starting a second would fail anyway, since
  // it would find the port taken.
  reuseExistingServer: !process.env.CI,
  timeout: 60_000,
};

export default defineConfig({
  testDir: 'tests/e2e',
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${SERVER_PORT}`,
    headless: true,
    launchOptions: {
      args: [
        // Chrome hides local IPs behind `.local` mDNS names in ICE candidates, and mDNS does not
        // resolve in a headless container — so two browser contexts on this machine cannot find
        // each other, and the failure looks exactly like a bug in the media code rather than a
        // privacy feature doing its job. Without this, every peer connection in media-link.spec.ts
        // times out with nothing to show for it.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
  /**
   * Two projects, so the genuinely CPU-hungry specs run on their own.
   *
   * `media-codec` encodes and decodes real H.264 in software — there is no hardware encoder in a
   * headless container — `media-stills` drives a detection model to solve a homography before it can
   * crop anything, `media-video` does both at once, and `scorer-onboarding` runs the device
   * self-test for real: five model loads and some thirty inferences on a CPU that has no GPU to fall
   * back from. Any of them beside the specs that are already driving a model is enough contention to
   * starve a scoring device's page until it misses the server heartbeat and is cut. The test that
   * then fails is `scorer-power`, which has nothing to do with any of it.
   *
   * The mechanism this comment used to blame — a device reading its own reconnect as a match start
   * and restarting a camera its owner had switched off — is fixed, and the fix is what
   * `scorer-power` now guards: `scorerReconnect.ts` classifies a fresh `scorer_state` as `started`
   * or `resumed` against the scoring context it already had, and `useScorerPower` restarts on a
   * `resumed` only where its own timer was what stopped the camera. See docs/vision.md, "Power
   * management". What is left here is the starvation itself.
   *
   * That is a separate question and is deliberately not addressed here. This only stops the
   * expensive newcomers from being the thing that provokes it: `dependencies` makes the `heavy`
   * project wait until everything else has finished.
   *
   * Note worker count is *not* the lever — the suite has failed at eight workers and passed at
   * thirteen. What matters is which files happen to overlap, not how many run at once.
   *
   * **`dependencies` orders projects; it does not serialise the files inside one.** The three specs
   * in `heavy` still run beside each other, and Playwright 1.62 offers no per-project `workers` to
   * change that — `Project` has no such field, so setting one is silently ignored rather than
   * rejected. A project containing a single file is therefore the only way to make a spec run on its
   * own, which is what `onboarding` below is for.
   */
  projects: [
    { name: 'app', testIgnore: /media-codec|media-stills|media-video|scorer-onboarding/ },
    { name: 'heavy', testMatch: /media-codec|media-stills|media-video/, dependencies: ['app'] },
    // A project of its own, after `heavy`, because it is one file and a project's files are the only
    // thing Playwright will run in parallel here. One file in a project of its own therefore runs
    // alone — which nothing inside `heavy` does, and which this needs. Adding it to `heavy` as a
    // fourth file cost a flake in roughly one run in three, and what failed was `media-stills`,
    // which has nothing to do with it.
    { name: 'onboarding', testMatch: /scorer-onboarding/, dependencies: ['heavy'] },
  ],
  // An explicit base URL means somebody else is running the app; there is nothing here to start.
  webServer: process.env.E2E_BASE_URL ? undefined : webServer,
  // Explicitly limit workers
  workers: process.env.CI ? 1 : "25%",
});
