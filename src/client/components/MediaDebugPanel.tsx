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

import { useEffect, useRef, useState } from 'react';
import { Box, Button, Group, Paper, Stack, Text } from '@mantine/core';
import type { MediaMesh } from '../hooks/useMediaMesh';
import type { ControlMessage } from '../../shared/media';
import type { LinkStats } from '../media/peerLink';
import type { StillTiming } from '../hooks/useStillResponder';
import type { EvidenceTiming } from '../hooks/useDartEvidence';
import type { PublisherStats } from '../media/videoPublisher';
import type { VideoFeed } from '../hooks/useVideoFeed';
import type { VideoOfferStats } from '../hooks/useVideoResponder';
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
  /** The source's standing offer, including roles and exact accepted peers. */
  publisherOffer?: () => VideoOfferStats | null;
  /** The feeds this frontend is watching. */
  feed?: VideoFeed;
}

/** Median and worst of a set of measurements. The spread is the interesting half. */
function summarise(values: number[]): string {
  if (values.length === 0) return '—';
  const sorted = [...values].sort((a, b) => a - b);
  return `${sorted[Math.floor(sorted.length / 2)]}/${sorted[sorted.length - 1]}ms`;
}

export function MediaDebugPanel({ media, stillTimings, evidenceTimings, publisherStats, publisherOffer, feed }: Props) {
  // Read once and kept. `e2eEnabled()` reads the query string, and react-router's `navigate()`
  // drops it the moment the app moves off "/" — so asking again later would answer no.
  const [visible] = useState(() => e2eEnabled());
  const [stats, setStats] = useState<Record<string, LinkStats>>({});
  const [open, setOpen] = useState(false);

  const { mesh, links, selfId, session, config, active, refresh } = media;
  const latest = useRef({ mesh, links, selfId, session, config, active, media, stillTimings, evidenceTimings, publisherStats, publisherOffer, feed });
  latest.current = { mesh, links, selfId, session, config, active, media, stillTimings, evidenceTimings, publisherStats, publisherOffer, feed };

  // The seam the e2e spec drives. Installed whenever the build allows it, panel open or not: a test
  // asserting that a link came up should not depend on anybody having clicked anything.
  useEffect(() => {
    if (!visible) return;
    const handle = {
      self: () => latest.current.selfId,
      session: () => latest.current.session,
      config: () => latest.current.config,
      active: () => latest.current.active,
      links: () => latest.current.links.map((l) => ({
        peerId: l.peer.peerId,
        kind: l.peer.kind,
        playerId: l.peer.playerId,
        polite: l.peer.polite,
        own: l.peer.own,
        role: l.peer.role,
        tier: l.peer.tier,
        send: l.peer.send,
        recv: l.peer.recv,
        state: l.state,
        ready: l.ready,
      })),
      sendControl: (peerId: string, message: ControlMessage) => latest.current.mesh?.link(peerId)?.sendControl(message),
      /** A round trip over the control channel — the mesh answers a ping without being asked to. */
      ping: (peerId: string, seq: number) => latest.current.mesh?.link(peerId)?.sendControl({ kind: 'ping', seq }),
      sendMedia: (peerId: string, bytes: number[]) =>
        latest.current.mesh?.link(peerId)?.sendMedia(new Uint8Array(bytes)),
      /** Same-peer ICE fault injection. This seam is absent unless `?e2e=1` installed it. */
      setLinkState: (peerId: string, state: 'connected' | 'disconnected' | 'failed') =>
        latest.current.mesh?.link(peerId)?.debugState(state),
      /** What has arrived. Media comes back as plain arrays so it survives the bridge to the test. */
      inbox: () => ({
        control: latest.current.media.inbox.control,
        media: latest.current.media.inbox.media.map((m) => ({ from: m.from, bytes: [...m.bytes] })),
        source: latest.current.media.inbox.source,
      }),
      stats: async (peerId: string) => latest.current.mesh?.link(peerId)?.stats(),
      /** What stills have cost. The device's split, and the frontend's round trip. */
      stills: () => ({
        captured: latest.current.stillTimings?.current ?? [],
        received: latest.current.evidenceTimings?.current ?? [],
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
        published: latest.current.publisherStats?.() ?? null,
        offer: latest.current.publisherOffer?.() ?? null,
        audience: latest.current.publisherOffer?.()?.audience ?? null,
        // Decoder counters change for every packet without forcing React to render every frame.
        // Read their live ref here; returning the stats captured by the last render made recovery
        // tests depend on whether a frame happened to beat the link-state render.
        watching: latest.current.feed?.feeds.map(({ canvas: _canvas, ...entry }) => ({
          ...entry,
          stats: latest.current.feed?.stats.current.find((current) =>
            current.peerId === entry.peerId && current.feedId === entry.feedId)?.stats ?? entry.stats,
        })) ?? [],
      }),
      /** The picture itself, as a data URL — the only way a test can assert it is not a black square. */
      frame: (peerId?: string) => {
        const entry = latest.current.feed?.feeds.find((candidate) => candidate.canvas && (!peerId || candidate.peerId === peerId));
        return entry?.canvas?.toDataURL('image/png') ?? null;
      },
    };
    (window as unknown as { __media: typeof handle }).__media = handle;
  }, [visible]);

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
      <Box
        pos="fixed"
        bottom={32}
        left={0}
        m="xs"
        ff="monospace"
        fz="xs"
        style={{ zIndex: 50 }}
        data-testid="media-debug"
      >
        <Button size="compact-xs" variant="default" onClick={() => setOpen((value) => !value)}>
          media · {links.filter((link) => link.state === 'connected').length}/{links.length}
          {!active && ' · off'}
        </Button>

        {open && (
          <Paper withBorder mt={4} p="xs" maw="90vw" bg="dark.8" style={{ overflowX: 'auto' }}>
            <Stack gap={4}>
              <Text fz="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                self {selfId?.slice(0, 8) ?? '—'} ·{' '}
                <Text
                  span
                  title={config?.iceServers.map((server) => server.urls).join('\n') || 'host candidates only'}
                >
                  ice {config?.iceServers.length ?? 0}
                </Text>
                {' '}· {config?.enabled ? 'allowed' : 'disabled'}
              </Text>

              {links.length === 0 && <Text fz="xs" c="gray.6">no peers offered</Text>}

              {(stillTimings?.current?.length ?? 0) > 0 && (
                <Text fz="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  capture ·
                  {' '}wait {summarise(stillTimings!.current.map((timing) => timing.waitMs))}
                  {' '}draw {summarise(stillTimings!.current.map((timing) => timing.drawMs))}
                  {' '}encode {summarise(stillTimings!.current.map((timing) => timing.encodeMs))}
                  {' '}· {Math.round(stillTimings!.current[stillTimings!.current.length - 1].bytes / 1024)}kB
                </Text>
              )}
              {(evidenceTimings?.current?.length ?? 0) > 0 && (
                <Text fz="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  evidence · round trip {summarise(evidenceTimings!.current.map((timing) => timing.roundTripMs))}
                </Text>
              )}

              <PublisherRow stats={publisherStats} offer={publisherOffer} open={open} />
              {feed?.feeds.map(({ peerId, feedId, label, status, choice }) => (
                <ReceiverRow
                  key={feedId}
                  peerId={peerId}
                  feedId={feedId}
                  label={label}
                  status={status}
                  choice={choice}
                  feed={feed}
                  open={open}
                />
              ))}

              {links.map((link) => {
                const linkStats = stats[link.peer.peerId] ?? {};
                return (
                  <Group key={link.peer.peerId} gap="xs" wrap="nowrap" style={{ whiteSpace: 'nowrap' }}>
                    <Text span fz="xs" c={stateMantineColor(link.state)}>{link.state}</Text>
                    <Text span fz="xs" c="gray.4">{link.peer.kind}</Text>
                    <Text span fz="xs" c="gray.6">{link.peer.role}</Text>
                    <Text span fz="xs" c="gray.3">{link.peer.peerId.slice(0, 8)}</Text>
                    <Text span fz="xs" c="gray.6">{link.peer.polite ? 'polite' : 'impolite'}</Text>
                    <Text span fz="xs" c="gray.6">{link.peer.send ? '↓' : ''}{link.peer.recv ? '↑' : ''}</Text>
                    {linkStats.localCandidateType && (
                      <Text span fz="xs" c="dimmed">{linkStats.localCandidateType}→{linkStats.remoteCandidateType}</Text>
                    )}
                    {linkStats.currentRoundTripTime !== undefined && (
                      <Text span fz="xs" c="dimmed">{Math.round(linkStats.currentRoundTripTime * 1000)}ms</Text>
                    )}
                    {linkStats.lastIceError && (
                      <Text span fz="xs" c="yellow.7" title={`${linkStats.iceErrors} ICE server errors`}>
                        ice {linkStats.lastIceError}
                      </Text>
                    )}
                  </Group>
                );
              })}
            </Stack>
          </Paper>
        )}
      </Box>
  );
}

function stateMantineColor(state: string): string {
  if (state === 'connected') return 'green.4';
  if (state === 'failed' || state === 'closed') return 'red.4';
  return 'yellow.4';
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
function PublisherRow({ stats, offer, open }: { stats?: () => PublisherStats | null; offer?: () => VideoOfferStats | null; open: boolean }) {
  const [shown, setShown] = useState<{ stats: PublisherStats | null; offer: VideoOfferStats | null } | null>(null);
  useEffect(() => {
    if (!open || (!stats && !offer)) return;
    const tick = () => setShown({ stats: stats?.() ?? null, offer: offer?.() ?? null });
    tick();
    const handle = setInterval(tick, 500);
    return () => clearInterval(handle);
  }, [open, stats, offer]);

  if (!shown?.offer) return null;
  const counters = shown.stats;
  const camCanvas = getCameraCanvas();
  const canvasLabel = camCanvas instanceof HTMLCanvasElement ? 'html' : camCanvas ? 'offscreen' : null;
  return (
    <Text fz="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
      offer {shown.offer.feedId.slice(0, 8)} · {shown.offer.audience.join(' ')} · {shown.offer.accepted.length} accepted
      {counters && ` · ${counters.frames}f ${counters.keyframes}k · ${Math.round(counters.bytes / 1024)}kB`}
      {canvasLabel && <Text span c="gray.6"> · {canvasLabel}</Text>}
      {counters && counters.dropped > 0 && <Text span c="yellow.5"> · {counters.dropped} dropped</Text>}
      {counters && counters.oversize > 0 && <Text span c="red.4"> · {counters.oversize} oversize</Text>}
      {counters && counters.missed > 0 && <Text span c="gray.6"> · {counters.missed} missed</Text>}
      {counters?.error && <Text span c="red.4"> · {counters.error}</Text>}
    </Text>
  );
}

/** One receiver's counters, polled only while the diagnostics panel is open. */
function ReceiverRow({ peerId, feedId, label, status, choice, feed, open }: {
  peerId: string;
  feedId: string;
  label?: string;
  status: string;
  choice: string;
  feed: VideoFeed;
  open: boolean;
}) {
  const [shown, setShown] = useState<{ decoded: number; dropped: number; gaps: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const tick = () => {
      const entry = feed.stats.current.find((s) => s.peerId === peerId);
      const counters = entry?.stats;
      setShown(counters ? { decoded: counters.decoded, dropped: counters.dropped, gaps: counters.gaps } : null);
    };
    tick();
    const handle = setInterval(tick, 500);
    return () => clearInterval(handle);
  }, [open, feed, peerId]);

  return (
    <Text fz="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
      offer {feedId.slice(0, 8)} · {label ?? peerId.slice(0, 8)} · {choice} · {status}
      {shown && ` · ${shown.decoded}f`}
      {shown && shown.gaps > 0 && <Text span c="yellow.5"> · {shown.gaps} gaps</Text>}
      {shown && shown.dropped > 0 && <Text span c="gray.6"> · {shown.dropped} dropped</Text>}
    </Text>
  );
}
