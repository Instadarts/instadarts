// Whether the STUN server this deployment carries speaks STUN.
//
// The unit tests take a reply apart with a decoder written from the RFC, which proves the bytes are
// what the specification says. It does not prove a browser agrees — and a browser is the only client
// this server will ever have. So this asks Chrome, and reads its answer in the one form that cannot
// be faked: a **server-reflexive candidate**, which Chrome will only produce for an address a STUN
// server told it about.
//
// ## Why one machine is enough to see one
//
// A reflexive candidate whose address equals the address the browser already had is redundant, and
// ICE eliminates it before anybody can observe it (RFC 8445 §5.1.3) — which is what happens on a
// real LAN, and is why the internal server is harmless and pointless there. Here it survives, for a
// reason peculiar to testing on one host: Chrome sends from its LAN interface and reaches the server
// over loopback, so the address the server reports back is not the address Chrome started from. The
// candidate that produces is proof the exchange happened.
//
// ## The control
//
// Chrome does *not* raise `icecandidateerror` for a STUN server that simply never answers — it keeps
// waiting, and gathering never completes at all. So the second half of this test points the same
// probe at a port with nothing behind it and requires that it produce nothing. Without it, a Chrome
// that had found that candidate some other way would pass the first half unnoticed.

import { test, expect, type Page } from '@playwright/test';
import type { MediaClientConfig } from '../../src/shared/config';

interface Gathered {
  /** Candidates by type, as ICE reported them. `srflx` is the one that means STUN answered. */
  types: string[];
  /** Whether gathering finished, rather than being cut off by the bound below. */
  complete: boolean;
}

/**
 * Gather candidates against one ICE server and report what came of it.
 *
 * A datachannel, because a peer connection with nothing on it has no reason to gather — and no media
 * tracks, for the same reason the app has none.
 */
function gather(page: Page, urls: string, waitMs: number): Promise<Gathered> {
  return page.evaluate(
    async ({ urls, waitMs }) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls }] });
      const types: string[] = [];
      pc.addEventListener('icecandidate', (event) => {
        if (event.candidate?.type) types.push(event.candidate.type);
      });

      pc.createDataChannel('stun-probe');
      await pc.setLocalDescription(await pc.createOffer());

      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        const check = () => {
          if (pc.iceGatheringState === 'complete') finish();
        };
        // Bounded, because a server that never answers is one of the outcomes being measured: with
        // nothing behind the port, gathering does not finish at all.
        const timer = setTimeout(finish, waitMs);
        pc.addEventListener('icegatheringstatechange', check);
        check();
      });

      const result = { types, complete: pc.iceGatheringState === 'complete' };
      pc.close();
      return result;
    },
    { urls, waitMs },
  );
}

function mediaConfig(page: Page): Promise<MediaClientConfig | null> {
  return page.evaluate(() => (window as any).__media?.config() ?? null);
}

test('Chrome gets a reflexive candidate from the internal STUN server', async ({ page }) => {
  await page.goto('/?e2e=1');

  await expect.poll(async () => await mediaConfig(page)).not.toBe(null);
  const config = (await mediaConfig(page))!;

  // Skipped rather than failed when there is no server to ask. A deployment reaches this state by
  // choosing to — `media.enabled: false`, or `iceUrls` without `internal` — and a run configured
  // that way is not a run where this has anything to say. The other route here, a listener that
  // could not bind, is the server's own to report: it says so on startup, and `stun.test.ts` pins
  // that it reports rather than throws.
  test.skip(
    !config.enabled || config.stunPort === null,
    'this deployment runs no internal STUN server',
  );

  // Resolved client-side against this page's own host, which is the whole mechanism: the server
  // never learns its own address and does not need to.
  const ours = `stun:${new URL(page.url()).hostname}:${config.stunPort}`;
  expect(config.iceServers.map((s) => s.urls)).toContain(ours);

  const answered = await gather(page, ours, 6000);
  expect(answered.complete).toBe(true);
  // The assertion. Chrome only mints `srflx` from an address a STUN server reported to it, so this
  // fails on anything wrong with the header, the magic cookie, the transaction id or the XOR masking
  // — none of which our own decoder would have caught, since it shares its reading with the encoder.
  expect(answered.types, `only got ${answered.types.join(', ')}`).toContain('srflx');

  // The control: the same probe one port over, where nothing is listening. Gathering hangs instead
  // of completing, and no reflexive candidate appears — which is what says the one above came from
  // our server rather than from the environment.
  const silent = await gather(page, `stun:${new URL(page.url()).hostname}:${config.stunPort! + 1}`, 3000);
  expect(silent.types).not.toContain('srflx');
  expect(silent.complete).toBe(false);
});
