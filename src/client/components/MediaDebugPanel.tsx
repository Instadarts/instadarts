// What the media mesh is actually doing, for the two audiences that need to know.
//
// Headless Chromium can tell you that two browser contexts on one machine connected. It cannot tell
// you whether a phone on your Wi-Fi reaches your laptop, or whether two households reach each other
// with no TURN — and those are the only questions that decide whether this feature works. This panel
// is where you read the answer off a real device, and the candidate types are the whole point of it:
// `host` means the two ends were on one network, `srflx` means they found each other through a NAT.
//
// Gated by the same `?e2e=1` seam as the power-management overrides, so production users never see
// it. It also exposes `window.__media`, which is what the e2e spec drives — the states
// below are readable, but a test should not have to scrape a screen for them.

import { useEffect, useState } from 'react';
import type { MediaMesh } from '../hooks/useMediaMesh';
import type { ControlMessage, MediaRole } from '../../shared/media';
import type { LinkStats } from '../media/peerLink';
import type { StillTiming } from '../hooks/useStillResponder';
import type { EvidenceTiming } from '../hooks/useDartEvidence';
import type { PublisherStats } from '../media/videoPublisher';
import type { VideoFeed } from '../hooks/useVideoFeed';
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
  /** The feeds this frontend is watching. */
  feed?: VideoFeed;
}

/** Median and worst of a set of measurements. The spread is the interesting half. */
function summarise(values: number[]): string {
  if (values.length === 0) return '—';
  const sorted = [...values].sort((a, b) => a - b);
  return `${sorted[Math.floor(sorted.length / 2)]}/${sorted[sorted.length - 1]}ms`;
}

export function MediaDebugPanel({ media, stillTimings, evidenceTimings, publisherStats, publisherAudience, feed }: Props) {
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
        const entry = feed?.feeds.find((candidate) => candidate.canvas && (!peerId || candidate.peerId === peerId));
        return entry?.canvas?.toDataURL('image/png') ?? null;
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
            self {selfId?.slice(0, 8) ?? '—'} ·{' '}
            {/* Hover for the urls themselves: `internal` has been resolved against this page's own
                host by now, so this is the only place to see what it became — or that it was
                dropped because the server had nothing listening. */}
            <span title={config?.iceServers.map((s) => s.urls).join('\n') || 'host candidates only'}>
              ice {config?.iceServers.length ?? 0}
            </span>
            {' '}· {config?.enabled ? 'allowed' : 'disabled'}
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

          {/* Video statistics only. The production match surface owns the picture. */}
          <PublisherRow stats={publisherStats} audience={publisherAudience} open={open} />
          {feed?.feeds.map(({ peerId, label, status, reason }) => (
            <ReceiverRow
              key={peerId}
              peerId={peerId}
              label={label}
              status={status}
              reason={reason}
              feed={feed}
              open={open}
            />
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
                {/* An ICE server that answered and refused. Not the same as one that is unreachable,
                    which raises nothing at all and shows up as a link that took two seconds to
                    negotiate. The link may well still say `connected` either way: host candidates
                    carry a LAN pair whether or not anything else worked. */}
                {s.lastIceError && (
                  <span className="text-amber-600" title={`${s.iceErrors} ICE server errors`}>
                    ice {s.lastIceError}
                  </span>
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

/** One receiver's counters, polled only while the diagnostics panel is open. */
function ReceiverRow({ peerId, label, status, reason, feed, open }: {
  peerId: string;
  label?: string;
  status: string;
  reason?: string;
  feed: VideoFeed;
  open: boolean;
}) {
  const [shown, setShown] = useState<{ on: boolean; reason?: string; decoded: number; dropped: number; gaps: number } | null>(null);

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

  return (
    <p className="mt-1 text-gray-500">
      watching {label ?? peerId.slice(0, 8)} · {status}{reason ? ` (${reason})` : ''}
      {shown && ` · ${shown.decoded}f`}
      {shown && shown.gaps > 0 && <span className="text-yellow-500"> · {shown.gaps} gaps</span>}
      {shown && shown.dropped > 0 && <span className="text-gray-600"> · {shown.dropped} dropped</span>}
    </p>
  );
}
