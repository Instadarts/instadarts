import { defineConfig } from '@playwright/test';

const SERVER_PORT = Number(process.env.PORT ?? 3000);
const CLIENT_PORT = Number(process.env.VITE_PORT ?? 5173);

/**
 * The app is two processes — the API/WebSocket server and Vite — and both are Playwright's to
 * start.
 *
 * They are declared separately rather than as one `npm run dev`, so each gets its own readiness
 * probe: the server answers /server-stats, and Vite answers its own root. Waiting only for Vite
 * would let the first test open a page and a WebSocket against a server that is not listening yet.
 *
 * `tsx` without `watch`: a test run has no files changing under it, and a watcher is one more thing
 * to shut down. Which matters, because shutting down is the other half of what this buys — the npm
 * script this replaces killed whatever held the two ports and left the wrappers above them running.
 */
/**
 * `[::1]` and not `localhost`, which costs four minutes a run on WSL2.
 *
 * Playwright probes each url once *before* starting anything — that is how it decides whether a
 * server is already up — and under WSL2 a connection to a closed port on 127.0.0.1 is not refused
 * but black-holed, so it sits through the full TCP SYN timeout of about 132 seconds. `localhost`
 * resolves to IPv4 first and pays it too. IPv6 loopback is refused immediately, and both servers
 * listen on it: Node binds dual-stack by default, and Vite's `host: true` covers it.
 */
const webServer = [
  {
    command: 'npx tsx src/server/index.ts',
    url: `http://[::1]:${SERVER_PORT}/server-stats`,
    // MEDIA is passed through so the suite can be run with the feature off — `MEDIA=0 npx playwright
    // test`. Worth having for something that must be disable-able: it is the only way to see that
    // the rest of the app does not quietly depend on it.
    env: { QUIET: '1', MEDIA: process.env.MEDIA ?? '1' },
  },
  {
    command: 'npx vite',
    url: `http://[::1]:${CLIENT_PORT}`,
  },
].map((server) => ({
  ...server,
  // A dev server already up is the one to test against; starting a second would fail anyway, since
  // both ports are strict.
  reuseExistingServer: !process.env.CI,
  timeout: 60_000,
}));

export default defineConfig({
  testDir: 'tests/e2e',
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${CLIENT_PORT}`,
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
   * crop anything, and `media-video` does both at once. Any of them beside the specs that are
   * already driving a model is enough contention
   * to starve a scoring device's page until it misses a heartbeat, and a scoring
   * device that reconnects mid-match restarts a camera its owner had switched off
   * (`useScorerLink` clears `scoring` on disconnect; `useScorerPower` reads its return as a match
   * beginning). The test that then fails is `scorer-power`, which has nothing to do with any of it.
   *
   * That underlying behaviour is a separate question and is deliberately not addressed here. This
   * only stops the expensive newcomers from being the thing that provokes it: `dependencies` makes
   * the `heavy` project wait until everything else has finished.
   *
   * Note worker count is *not* the lever — the suite has failed at eight workers and passed at
   * thirteen. What matters is which files happen to overlap, not how many run at once.
   */
  projects: [
    { name: 'app', testIgnore: /media-codec|media-stills|media-video/ },
    { name: 'heavy', testMatch: /media-codec|media-stills|media-video/, dependencies: ['app'] },
  ],
  // An explicit base URL means somebody else is running the app; there is nothing here to start.
  webServer: process.env.E2E_BASE_URL ? undefined : webServer,
});
