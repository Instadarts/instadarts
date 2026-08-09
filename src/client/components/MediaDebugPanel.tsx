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

import { useEffect, useState } from 'react';
import type { MediaMesh } from '../hooks/useMediaMesh';
import type { LinkStats } from '../media/peerLink';
import { e2eEnabled } from '../lib/e2e';

interface Props {
  media: MediaMesh;
}

export function MediaDebugPanel({ media }: Props) {
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
        send: l.peer.send,
        recv: l.peer.recv,
        state: l.state,
        ready: l.ready,
      })),
      sendControl: (peerId: string, message: unknown) => mesh?.link(peerId)?.sendControl(message),
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
    };
    (window as unknown as { __media: typeof handle }).__media = handle;
  }, [visible, mesh, links, selfId, config, active, media.inbox]);

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
    <div className="fixed bottom-0 left-0 z-50 m-2 text-xs font-mono" data-testid="media-debug">
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
          {links.map((l) => {
            const s = stats[l.peer.peerId] ?? {};
            return (
              <div key={l.peer.peerId} className="mt-1 flex gap-2 whitespace-nowrap">
                <span className={stateColor(l.state)}>{l.state}</span>
                <span className="text-gray-400">{l.peer.kind}</span>
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
