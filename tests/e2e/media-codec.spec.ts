// Whether encoded video survives the trip, which is the assumption everything else rests on.
//
// The whole media design turns on one bet: that a link carries no video track, and that a single
// WebCodecs `VideoEncoder` writing to N unreliable datachannels beats N browser encoders. If the
// encoded bitstream cannot make that trip and come back out of a `VideoDecoder`, the design is
// wrong — and that is far cheaper to find out here than after a feature has been built on it.
//
// So this is not a test of the media feature; the feature has no encoder yet. It is a test of the
// premise, run over the real transport: two real browsers, a real peer connection, the real
// unreliable channel. It should be deleted the moment part 3's encoder has tests of its own.
//
// Kept in its own file because Playwright parallelises per file, and this one is slow — it waits on
// an encoder, a network and a decoder.

import { test, expect, type Page } from '@playwright/test';

/**
 * Enough for a keyframe and a run of deltas, and no more.
 *
 * There is no hardware encoder in a headless container, so every frame here is software H.264 while
 * the vision specs are running their model on the same cores. At thirty this test was heavy enough
 * to make a scoring device elsewhere in the suite miss a heartbeat, reconnect, and fail a test that
 * had nothing to do with it. What it proves does not depend on the count.
 */
const FRAMES = 12;

/** The profile the server ships, hard-coded here so a change to it is a change to this test too. */
const PROFILE = { codec: 'avc1.42001f', width: 320, height: 320, frameRate: 15, bitrate: 500_000 };

test.describe('encoded video over a link', () => {
  test('encodes on one device, decodes on the other', async ({ browser }) => {
    const alice = await (await browser.newContext()).newPage();
    const bob = await (await browser.newContext()).newPage();

    // Nothing to do with darts: two frontends in one running match are the shortest route to a link.
    await alice.goto('/?e2e=1');
    await alice.click('text=Create Online Match');
    await alice.getByRole('textbox', { name: 'New player', exact: true }).fill('Alice');
    await alice.click('button:has-text("Add")');
    const code = (await alice.locator('text=Invite Code').locator('..').locator('code').textContent())!;

    await bob.goto(`/lobby/join/${code.trim()}?e2e=1`);
    await bob.getByRole('textbox', { name: 'New player', exact: true }).fill('Bob');
    await bob.click('button:has-text("Add")');
    await expect(alice.locator('text=Bob')).toBeVisible({ timeout: 5000 });
    await alice.getByRole('button', { name: /Start Match/i }).click();
    await alice.waitForURL('**/match/**');
    await bob.waitForURL('**/match/**');

    await expect
      .poll(async () => alice.evaluate(() =>
        (window as any).__media.links().filter((l: any) =>
          l.kind === 'user' && l.state === 'connected' && l.ready).length),
        { timeout: 20_000 })
      .toBe(1);
    await expect
      .poll(async () => bob.evaluate(() =>
        (window as any).__media.links().filter((l: any) =>
          l.kind === 'user' && l.state === 'connected' && l.ready).length),
        { timeout: 20_000 })
      .toBe(1);
    const bobId = (await alice.evaluate(() =>
      (window as any).__media.links().find((l: any) =>
        l.kind === 'user' && l.state === 'connected' && l.ready)?.peerId))!;
    expect(bobId, 'Bob had no ready link after link setup completed').toBeTruthy();

    // Is the codec even available for encoding on this machine? A `false` here is a finding, not a
    // flake — it would mean the fixed profile has to change.
    const supported = await alice.evaluate(async (profile) => {
      const support = await (window as any).VideoEncoder.isConfigSupported(profile);
      return Boolean(support?.supported);
    }, PROFILE);
    expect(supported, `${PROFILE.codec} is not encodable here`).toBe(true);

    // Encode a moving picture — a still one would compress to almost nothing and prove less — and
    // write each chunk to the media channel as it comes out.
    const result = await alice.evaluate(async ({ profile, frames, peerId }) => {
      const canvas = new OffscreenCanvas(profile.width, profile.height);
      const ctx = canvas.getContext('2d')!;

      let encoded = 0;
      let sent = 0;
      const encoder = new (window as any).VideoEncoder({
        output: (chunk: any) => {
          // One frame, one message: SCTP drops a whole message rather than half of one, so this is
          // the granularity that makes a loss a missing frame instead of a corrupt one.
          const body = new Uint8Array(chunk.byteLength);
          chunk.copyTo(body);
          const header = new Uint8Array([chunk.type === 'key' ? 1 : 0]);
          const packet = new Uint8Array(header.length + body.length);
          packet.set(header);
          packet.set(body, header.length);
          if ((window as any).__media.sendMedia(peerId, [...packet])) sent += 1;
          encoded += 1;
        },
        error: (e: unknown) => { (window as any).__encodeError = String(e); },
      });
      encoder.configure({
        codec: profile.codec,
        width: profile.width,
        height: profile.height,
        bitrate: profile.bitrate,
        framerate: profile.frameRate,
        latencyMode: 'realtime',
        avc: { format: 'annexb' },
      });

      for (let i = 0; i < frames; i++) {
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, profile.width, profile.height);
        ctx.fillStyle = '#0f0';
        ctx.fillRect((i * 13) % profile.width, (i * 7) % profile.height, 80, 80);
        const frame = new (window as any).VideoFrame(canvas, {
          timestamp: (i * 1e6) / profile.frameRate,
          duration: 1e6 / profile.frameRate,
        });
        encoder.encode(frame, { keyFrame: i === 0 });
        frame.close();
        // Paced rather than dumped: thirty frames at once would tell us about the send queue
        // instead of about the codec.
        await new Promise((r) => setTimeout(r, 1000 / profile.frameRate));
      }
      await encoder.flush();
      encoder.close();
      return { encoded, sent };
    }, { profile: PROFILE, frames: FRAMES, peerId: bobId });

    expect(await alice.evaluate(() => (window as any).__encodeError)).toBeUndefined();
    expect(result.encoded).toBeGreaterThan(0);
    expect(result.sent, 'an encoded chunk found the media channel unwritable').toBe(result.encoded);

    // The channel is unreliable by design, so "most of them" is the honest bar. Losing everything
    // would be the finding.
    await expect
      .poll(async () => bob.evaluate(() => (window as any).__media.inbox().media.length), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(Math.floor(result.sent * 0.8));

    // And out the other side: the bytes that arrived are a decodable H.264 stream.
    const decoded = await bob.evaluate(async (profile) => {
      const received = (window as any).__media.inbox().media as { bytes: number[] }[];
      const sizes: string[] = [];
      const decoder = new (window as any).VideoDecoder({
        // `displayWidth`/`displayHeight`, not the coded size: H.264 pads its coded dimensions out
        // to whole macroblocks, and the coded size that comes back is the encoder's business rather
        // than ours — at the 480×480 this profile used to carry, frames decoded with a codedHeight
        // of 482. The display size is the picture that was actually sent.
        output: (frame: any) => { sizes.push(`${frame.displayWidth}x${frame.displayHeight}`); frame.close(); },
        error: () => {},
      });
      decoder.configure({ codec: profile.codec, codedWidth: profile.width, codedHeight: profile.height });

      for (const { bytes } of received) {
        const packet = new Uint8Array(bytes);
        try {
          decoder.decode(new (window as any).EncodedVideoChunk({
            type: packet[0] === 1 ? 'key' : 'delta',
            timestamp: 0,
            data: packet.subarray(1),
          }));
        } catch {
          // A delta frame whose keyframe never arrived. Exactly what an unreliable channel does,
          // and exactly why part 3 needs a keyframe request — not a reason to fail here.
        }
      }
      await decoder.flush().catch(() => {});
      decoder.close();
      return sizes;
    }, PROFILE);

    expect(decoded.length, 'nothing decoded on the far side').toBeGreaterThan(0);
    expect(decoded[0]).toBe(`${PROFILE.width}x${PROFILE.height}`);
  });
});
