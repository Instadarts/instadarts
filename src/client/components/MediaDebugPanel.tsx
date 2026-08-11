// What the media mesh is actually doing, for the two audiences that need to know.
//
// Headless Chromium can tell you that two browser contexts on one machine connected. It cannot tell
// you whether a phone on your Wi-Fi reaches your laptop, or whether two households reach each other
// with no TURN — and those are the only questions that decide whether this feature works. This panel
// is where you read the answer off a real device, and the candidate types are the whole point of it:
// `host` means the two ends were on one network, `srflx` means they found each other through a NAT.
//
// Gated by the same `?e2e=1` seam as the power-management overrides, so it does not exist in a
// shipped bundle. It also exposes `window.__media`, which is what the e2e spec drives — the states
// below are readable, but a test should not have to scrape a screen for them.

import { useEffect, useRef, useState } from 'react';
import type { MediaMesh } from '../hooks/useMediaMesh';
import type { ControlMessage, MediaRole } from '../../shared/media';
import type { LinkStats } from '../media/peerLink';
import type { StillTiming } from '../hooks/useStillResponder';
import type { EvidenceTiming } from '../hooks/useDartEvidence';
import type { PublisherStats } from '../media/videoPublisher';
import type { VideoFeed } from '../hooks/useVideoFeed';
import { videoEncoding } from '../lib/appConfig';
import { drawOverlay, flashAt, NO_OVERLAY, type FlashText, type OverlayState } from './feedOverlay';
import { e2eEnabled } from '../lib/e2e';
import { getCameraCanvas } from '../vision/videoCamera';

interface Props {
  media: MediaMesh;
  /**
   * What each still cost on the device that took it. Only a scoring device has these — a frontend
   * can time the round trip and nothing inside it.
   */
  stillTimings?: React.RefObject<StillTiming[]>;
  /** What each dart's picture cost end to end, from the asking side. A frontend's view. */
  evidenceTimings?: React.RefObject<EvidenceTiming[]>;
  /**
   * What the feed this device is publishing has cost, read at the moment of asking. A scoring
   * device's view. See `VideoResponder.stats` for why this is a function and not a snapshot.
   */
  publisherStats?: () => PublisherStats | null;
  /** Who that feed is currently addressed to. Null when nothing is publishing. */
  publisherAudience?: () => readonly MediaRole[] | null;
  /** The feeds this frontend is watching, and the canvases they land in. */
  feed?: VideoFeed;
  /**
   * What the match looks like right now, drawn over a feed and recorded with it.
   *
   * A frontend's to supply and a scoring device's to know nothing about: a camera sends a picture of
   * a board, and whose throw it is has never been on it.
   */
  overlay?: OverlayState;
}

/** Median and worst of a set of measurements. The spread is the interesting half. */
function summarise(values: number[]): string {
  if (values.length === 0) return '—';
  const sorted = [...values].sort((a, b) => a - b);
  return `${sorted[Math.floor(sorted.length / 2)]}/${sorted[sorted.length - 1]}ms`;
}

export function MediaDebugPanel({ media, stillTimings, evidenceTimings, publisherStats, publisherAudience, feed, overlay }: Props) {
  // Read once and kept. `e2eEnabled()` reads the query string, and react-router's `navigate()`
  // drops it the moment the app moves off "/" — so asking again later would answer no.
  const [visible] = useState(() => e2eEnabled());
  const [stats, setStats] = useState<Record<string, LinkStats>>({});
  const [open, setOpen] = useState(false);

  const { mesh, links, selfId, config, active, refresh } = media;

  // The seam the e2e spec drives. Installed whenever the build allows it, panel open or not: a test
  // asserting that a link came up should not depend on anybody having clicked anything.
  useEffect(() => {
    if (!visible) return;
    const handle = {
      self: () => selfId,
      config: () => config,
      active: () => active,
      links: () => links.map((l) => ({
        peerId: l.peer.peerId,
        kind: l.peer.kind,
        label: l.peer.label,
        polite: l.peer.polite,
        own: l.peer.own,
        role: l.peer.role,
        tier: l.peer.tier,
        send: l.peer.send,
        recv: l.peer.recv,
        state: l.state,
        ready: l.ready,
      })),
      sendControl: (peerId: string, message: ControlMessage) => mesh?.link(peerId)?.sendControl(message),
      /** A round trip over the control channel — the mesh answers a ping without being asked to. */
      ping: (peerId: string, seq: number) => mesh?.link(peerId)?.sendControl({ kind: 'ping', seq }),
      sendMedia: (peerId: string, bytes: number[]) =>
        mesh?.link(peerId)?.sendMedia(new Uint8Array(bytes)),
      /** What has arrived. Media comes back as plain arrays so it survives the bridge to the test. */
      inbox: () => ({
        control: media.inbox.control,
        media: media.inbox.media.map((m) => ({ from: m.from, bytes: [...m.bytes] })),
      }),
      stats: async (peerId: string) => mesh?.link(peerId)?.stats(),
      /** What stills have cost. The device's split, and the frontend's round trip. */
      stills: () => ({
        captured: stillTimings?.current ?? [],
        received: evidenceTimings?.current ?? [],
      }),
      /**
       * What the live feed is doing, from whichever end this is.
       *
       * `published` is a camera's own account — frames encoded, keyframes, bytes, and what it threw
       * away because a link was behind. `watching` is a viewer's, one entry per peer sending to us.
       * A test asserting that video actually flowed has nowhere else to look, and neither does anyone
       * holding a real phone.
       */
      video: () => ({
        published: publisherStats?.() ?? null,
        audience: publisherAudience?.() ?? null,
        watching: feed?.stats.current ?? [],
      }),
      /** The picture itself, as a data URL — the only way a test can assert it is not a black square. */
      frame: (peerId?: string) => {
        const entry = feed?.canvases.find((c) => !peerId || c.peerId === peerId);
        return entry ? entry.canvas.toDataURL('image/png') : null;
      },
    };
    (window as unknown as { __media: typeof handle }).__media = handle;
  }, [visible, mesh, links, selfId, config, active, media.inbox, stillTimings, evidenceTimings, publisherStats, publisherAudience, feed]);

  // Stats have to be pulled rather than pushed, so the panel polls while it is open and not
  // otherwise — getStats on every link once a second is not free.
  useEffect(() => {
    if (!visible || !open || !mesh) return;
    const tick = async () => {
      refresh();
      const next: Record<string, LinkStats> = {};
      await Promise.all(links.map(async (l) => { next[l.peer.peerId] = (await mesh.link(l.peer.peerId)?.stats()) ?? {}; }));
      setStats(next);
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, open, mesh, links.length]);

  if (!visible) return null;

  return (
    <div className="fixed bottom-8 left-0 z-50 m-2 text-xs font-mono" data-testid="media-debug">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-gray-300"
      >
        media · {links.filter((l) => l.state === 'connected').length}/{links.length}
        {!active && ' · off'}
      </button>

      {open && (
        <div className="mt-1 p-2 bg-gray-900 border border-gray-700 rounded max-w-[90vw] overflow-x-auto">
          <p className="text-gray-500">
            self {selfId?.slice(0, 8) ?? '—'} · ice {config?.iceServers.length ?? 0} · {config?.enabled ? 'allowed' : 'disabled'}
          </p>
          {links.length === 0 && <p className="text-gray-600 mt-1">no peers offered</p>}

          {/* Stills, median/worst. The spread is what says whether a capture is waiting on something
              else rather than simply being expensive. */}
          {(stillTimings?.current?.length ?? 0) > 0 && (
            <p className="mt-1 text-gray-500">
              capture ·
              {' '}wait {summarise(stillTimings!.current.map((t) => t.waitMs))}
              {' '}draw {summarise(stillTimings!.current.map((t) => t.drawMs))}
              {' '}encode {summarise(stillTimings!.current.map((t) => t.encodeMs))}
              {' '}· {Math.round(stillTimings!.current[stillTimings!.current.length - 1].bytes / 1024)}kB
            </p>
          )}
          {(evidenceTimings?.current?.length ?? 0) > 0 && (
            <p className="mt-1 text-gray-500">
              evidence · round trip {summarise(evidenceTimings!.current.map((t) => t.roundTripMs))}
            </p>
          )}

          {/* The feed, from whichever end this is. A camera reports what it encoded; a viewer
              reports what survived the trip, and shows the picture — which is the only way to tell a
              feed that is working from one that is delivering frames of nothing. */}
          <PublisherRow stats={publisherStats} audience={publisherAudience} open={open} />
          {feed?.canvases.map(({ peerId, canvas }) => (
            <FeedView key={peerId} peerId={peerId} canvas={canvas} feed={feed} open={open} overlay={overlay} />
          ))}
          {links.map((l) => {
            const s = stats[l.peer.peerId] ?? {};
            return (
              <div key={l.peer.peerId} className="mt-1 flex gap-2 whitespace-nowrap">
                <span className={stateColor(l.state)}>{l.state}</span>
                <span className="text-gray-400">{l.peer.kind}</span>
                <span className="text-gray-600">{l.peer.role}</span>
                <span className="text-gray-300">{l.peer.label ?? l.peer.peerId.slice(0, 8)}</span>
                <span className="text-gray-600">{l.peer.polite ? 'polite' : 'impolite'}</span>
                <span className="text-gray-600">{l.peer.send ? '↓' : ''}{l.peer.recv ? '↑' : ''}</span>
                {s.localCandidateType && (
                  <span className="text-gray-500">{s.localCandidateType}→{s.remoteCandidateType}</span>
                )}
                {s.currentRoundTripTime !== undefined && (
                  <span className="text-gray-500">{Math.round(s.currentRoundTripTime * 1000)}ms</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function stateColor(state: string): string {
  if (state === 'connected') return 'text-green-400';
  if (state === 'failed' || state === 'closed') return 'text-red-400';
  return 'text-yellow-400';
}

/**
 * What this device's own feed is costing.
 *
 * Polled rather than pushed, for the same reason the link stats are: the publisher counts fifteen
 * times a second, and re-rendering the app at that rate to move a number would cost more than the
 * feed does. The poll lives here, where a stale number is only a slightly late display — not in the
 * seam a test reads. `dropped` is the one to watch — it is the backpressure policy doing its job, and a
 * number that climbs steadily means the link cannot carry what the profile asks for. `oversize` is
 * the one to be alarmed by: those are frames no link would take at all, nearly always keyframes, and
 * a picture whose keyframes are not arriving is a picture that comes apart on its own.
 */
function PublisherRow({ stats, audience, open }: { stats?: () => PublisherStats | null; audience?: () => readonly MediaRole[] | null; open: boolean }) {
  const [shown, setShown] = useState<PublisherStats | null>(null);
  useEffect(() => {
    if (!open || !stats) return;
    const tick = () => setShown(stats());
    tick();
    const handle = setInterval(tick, 500);
    return () => clearInterval(handle);
  }, [open, stats]);

  if (!shown) return null;
  const camCanvas = getCameraCanvas();
  const canvasLabel = camCanvas instanceof HTMLCanvasElement ? 'html' : camCanvas ? 'offscreen' : null;
  return (
    <p className="mt-1 text-gray-500">
      publishing · {(audience?.() ?? []).join(' ') || '—'} · {shown.frames}f {shown.keyframes}k · {Math.round(shown.bytes / 1024)}kB
      {canvasLabel && <span className="text-gray-600"> · {canvasLabel}</span>}
      {shown.dropped > 0 && <span className="text-yellow-500"> · {shown.dropped} dropped</span>}
      {shown.oversize > 0 && <span className="text-red-400"> · {shown.oversize} oversize</span>}
      {shown.missed > 0 && <span className="text-gray-600"> · {shown.missed} missed</span>}
      {shown.error && <span className="text-red-400"> · {shown.error}</span>}
    </p>
  );
}

/**
 * The container this browser will actually record into.
 *
 * Asked rather than assumed, because no browser supports all of these: Chrome records WebM and has
 * only lately learned MP4, Safari records MP4 and not WebM, Firefox records WebM and not MP4.
 * Whichever answers first decides the file's extension too, so a clip is never named after a format
 * it is not in.
 *
 * **MP4 first, and not because it is the nicer format.** `MediaRecorder` writes a container as it
 * goes, without knowing how long the recording will turn out to be — and a WebM written that way has
 * no Cues element and no Duration, so a player loads it and reports `duration: Infinity`. It plays
 * from the start and the scrubber is furniture: VLC and Chrome both refuse to seek in one. The
 * fragmented MP4 the same recorder writes carries a real duration in its `moov`, and both seek in
 * it. Measured, not assumed — 3s clips out of this Chromium:
 *
 * ```
 * probe.webm       duration=Infinity   seekable-end=Infinity   0 Cues elements
 * probe-avc1.mp4   duration=2.981633   seekable-end=2.981633
 * ```
 *
 * `avc1` is asked for explicitly because bare `video/mp4` gave VP9-in-MP4 here — playable, four
 * times the size for the same three seconds, and a good deal fussier about what will open it.
 *
 * The WebM entries stay as the fallback for a browser with no MP4 recorder. An unseekable clip is
 * worth more than no clip; it is just not worth *preferring*.
 */
function recordingType(): string | null {
  if (typeof MediaRecorder !== 'function') return null;
  const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/**
 * Stop a recording growing past this, in bytes.
 *
 * A recording lives in memory until it is saved and the only thing that ends one is somebody
 * remembering to press the button again. Generous — tens of minutes at this picture size — and it
 * fails by keeping what it has rather than by taking the tab down.
 */
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;

/**
 * One feed being watched: the picture, what it took to get it, and a button that saves a clip.
 *
 * ## Two canvases, on purpose
 *
 * The receiver owns one and paints the decoded picture into it. This component owns a second, and on
 * every animation frame draws the first into it and the overlay on top. The recording is of the
 * second.
 *
 * Compositing rather than drawing into the receiver's canvas buys two things. The raw picture stays
 * raw, so `__media.frame()` and the fingerprints the director tests compare see the board and not a
 * player's name written across it. And the overlay animates on its own clock rather than only when a
 * video frame happens to arrive, which at fifteen frames a second is the difference between a flash
 * that moves and one that stutters.
 */
function FeedView({ peerId, canvas, feed, open, overlay }: {
  peerId: string;
  canvas: HTMLCanvasElement;
  feed: VideoFeed;
  open: boolean;
  overlay?: OverlayState;
}) {
  const composite = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState<{ on: boolean; reason?: string; decoded: number; dropped: number; gaps: number } | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordedBytes, setRecordedBytes] = useState(0);

  // Read by the draw loop, which must not restart every time a dart lands.
  const state = useRef<OverlayState>(NO_OVERLAY);
  state.current = overlay ?? NO_OVERLAY;
  /** The flash in progress: what it says, and when it began. */
  const flash = useRef<{ text: FlashText; startedAt: number } | null>(null);
  const lastDarts = useRef(0);

  // A dart appeared. Not a dart *changed* — undo shortens the visit and a new visit empties it, and
  // neither is something to celebrate.
  const darts = overlay?.darts.length ?? 0;
  if (overlay && darts > lastDarts.current) {
    // Copied, not read live: the flash is a second long, and a visit that is submitted underneath it
    // would otherwise rewrite what it says half way through.
    flash.current = { text: overlay.flash, startedAt: performance.now() };
  }
  lastDarts.current = darts;

  // Composite while anybody could be looking, and while anybody is recording even if they are not.
  useEffect(() => {
    if (!open && !recording) return;
    const target = composite.current;
    const ctx = target?.getContext('2d', { alpha: false });
    if (!target || !ctx) return;

    let handle = 0;
    const draw = () => {
      handle = requestAnimationFrame(draw);
      if (canvas.width === 0) return;
      if (target.width !== canvas.width) { target.width = canvas.width; target.height = canvas.height; }
      ctx.drawImage(canvas, 0, 0);

      const current = flash.current;
      const showing = current ? flashAt(current.startedAt, performance.now(), current.text) : null;
      if (current && !showing) flash.current = null;
      drawOverlay(ctx, target.width, state.current, showing);
    };
    draw();
    return () => cancelAnimationFrame(handle);
  }, [open, recording, canvas]);

  useEffect(() => {
    if (!open) return;
    const tick = () => {
      const entry = feed.stats.current.find((s) => s.peerId === peerId);
      setShown(entry ? { on: entry.on, reason: entry.reason, ...entry.stats } : null);
    };
    tick();
    const handle = setInterval(tick, 500);
    return () => clearInterval(handle);
  }, [open, feed, peerId]);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const toggleRecording = () => {
    if (recorder.current) {
      // The file is built in `onstop`, which fires after the last `dataavailable` — collecting it
      // here would drop whatever the recorder had not handed over yet.
      recorder.current.stop();
      return;
    }

    const target = composite.current;
    const type = recordingType();
    if (!target || !type) return;

    // Captured from the composite, so what is saved is what is on screen. The rate is the profile's:
    // the source is fifteen frames a second and asking for more would only duplicate them.
    const stream = target.captureStream(videoEncoding().frameRate);
    const media = new MediaRecorder(stream, {
      mimeType: type,
      // Twice the source's, because this is a re-encode of an already-lossy picture and matching the
      // original bitrate would compound the artefacts rather than preserve them.
      videoBitsPerSecond: videoEncoding().bitrate * 2,
    });

    chunks.current = [];
    setRecordedBytes(0);
    media.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      chunks.current.push(event.data);
      const total = chunks.current.reduce((sum, part) => sum + part.size, 0);
      setRecordedBytes(total);
      if (total >= MAX_RECORDING_BYTES) media.stop();
    };
    media.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      recorder.current = null;
      setRecording(false);
      if (chunks.current.length > 0) save(new Blob(chunks.current, { type }), peerId, type);
      chunks.current = [];
    };

    // A chunk a second rather than one at the end: it bounds what is lost if the tab dies mid-clip,
    // and it is what makes the byte counter beside the button move.
    media.start(1000);
    recorder.current = media;
    setRecording(true);
  };

  useEffect(() => () => { recorder.current?.stop(); }, []);

  return (
    <div className="mt-1">
      <p className="text-gray-500">
        watching {peerId.slice(0, 8)}
        {shown && ` · ${shown.decoded}f`}
        {shown && shown.gaps > 0 && <span className="text-yellow-500"> · {shown.gaps} gaps</span>}
        {shown && shown.dropped > 0 && <span className="text-gray-600"> · {shown.dropped} dropped</span>}
        {shown && !shown.on && <span className="text-red-400"> · off{shown.reason ? ` (${shown.reason})` : ''}</span>}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <button
          onClick={toggleRecording}
          disabled={recordingType() === null}
          className={`px-2 py-0.5 rounded border disabled:opacity-40 ${
            recording ? 'border-red-500 text-red-400' : 'border-gray-700 text-gray-400 hover:text-gray-200'}`}
        >
          {recording ? '■ stop' : '● rec'}
        </button>
        {recording && <span className="text-gray-500">{Math.round(recordedBytes / 1024)}kB</span>}
      </div>
      {/* Shown at the profile's own size, one recorded pixel to one screen pixel. Scaling it down
          would hide the thing anyone opens this panel to judge. */}
      <canvas ref={composite} className="mt-1 bg-black rounded" data-testid={`feed-${peerId.slice(0, 8)}`} />
    </div>
  );
}

/** Hand a finished clip to the browser as a file. */
function save(blob: Blob, peerId: string, type: string): void {
  const url = URL.createObjectURL(blob);
  const when = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const link = document.createElement('a');
  link.href = url;
  link.download = `board-${peerId.slice(0, 8)}-${when}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
  link.click();
  // On a delay: a synthetic click starts the save asynchronously, and revoking underneath it
  // cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
