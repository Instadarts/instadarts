// The set of links one client holds, driven entirely by the roster the server publishes.
//
// The roster is authoritative in **both** directions, and that is the only teardown mechanism in the
// whole feature: a peer that is no longer offered has its link closed. Leaving a match, a match
// closing, an opponent's phone dropping off the Wi-Fi and a browser opting out all arrive here as
// the same event — a name missing from a list — which is why none of them needs a message of its own.
//
// This is also where the **single encoder** will live in part 3. Not in a link: encoding once and
// writing the same chunks to every open media channel is the entire reason a link carries no video
// track. `publish` below is the seam that will drive it.

import type { MediaPeer, SignalDescription, VideoProfile } from '../../shared/media';
import { createPeerLink, type LinkState, type PeerLink } from './peerLink';
import type { IceServerConfig } from '../../shared/media';

export interface MeshOptions {
  iceServers: IceServerConfig[];
  /**
   * How a publisher should encode. Carried but not yet read: it is what the single `VideoEncoder`
   * will be configured from, and it is here rather than in a link because there is only ever one of
   * it. ⏳ part 3.
   */
  video: VideoProfile;
  /** Send one end of a negotiation to a peer, through whatever socket the app owns. */
  signal: (to: string, description: SignalDescription) => void;
  /** Something about the links changed and anything watching should look again. */
  onChange: () => void;
  /** A control-channel message from a peer. */
  onControl?: (from: string, data: unknown) => void;
  /** One encoded chunk from a peer. */
  onMedia?: (from: string, data: ArrayBuffer) => void;
}

/** A link, as anything outside this module needs to see it. */
export interface MeshLink {
  peer: MediaPeer;
  state: LinkState;
  ready: boolean;
}

export interface Mesh {
  /** Reconcile against a freshly published roster: open what is new, close what is gone. */
  setRoster(peers: MediaPeer[]): void;
  /** A description arrived for one of these links. */
  deliver(from: string, description: SignalDescription): void;
  links(): MeshLink[];
  /** The link to one peer, for anything that talks to one directly. */
  link(peerId: string): PeerLink | undefined;
  /** Every peer that may receive from us — where one encoder's output goes. */
  viewers(): PeerLink[];
  /** Close everything. The mesh may be used again afterwards; a new roster reopens it. */
  closeAll(): void;
}

export function createMesh(options: MeshOptions): Mesh {
  const { iceServers, signal, onChange, onControl, onMedia } = options;

  const links = new Map<string, PeerLink>();
  const peers = new Map<string, MediaPeer>();
  /**
   * Descriptions that arrived before their link existed.
   *
   * Rare but real: two peers are told about each other in whatever order their sockets are served,
   * so an offer can beat the roster that authorises it by a few milliseconds. Dropping it would
   * cost the link a full negotiation round for no reason.
   */
  const early = new Map<string, SignalDescription[]>();

  function open(peer: MediaPeer): PeerLink {
    const link = createPeerLink({
      peerId: peer.peerId,
      polite: peer.polite,
      iceServers,
      signal: (description) => signal(peer.peerId, description),
      onChange: () => onChange(),
      onControl: (data) => {
        // Answered here rather than by whoever is listening, so that "is this link alive" has an
        // answer even when nothing is watching and nothing is being sent. It is also the only
        // round-trip a link has before there is any media to carry.
        const message = data as { kind?: string; seq?: number };
        if (message?.kind === 'ping') link.sendControl({ kind: 'pong', seq: message.seq });
        onControl?.(peer.peerId, data);
      },
      onMedia: (data) => onMedia?.(peer.peerId, data),
    });
    links.set(peer.peerId, link);

    for (const description of early.get(peer.peerId) ?? []) void link.accept(description);
    early.delete(peer.peerId);
    return link;
  }

  return {
    setRoster(next: MediaPeer[]): void {
      const offered = new Set(next.map((p) => p.peerId));

      for (const [peerId, link] of links) {
        if (offered.has(peerId)) continue;
        link.close();
        links.delete(peerId);
        peers.delete(peerId);
      }

      for (const peer of next) {
        const known = peers.get(peer.peerId);
        peers.set(peer.peerId, peer);
        // A peer whose politeness changed would be a different negotiation, and the server never
        // changes it for a live pair — but reopening on that basis is cheap insurance against a
        // half-negotiated link that can never settle.
        if (known && known.polite !== peer.polite) {
          links.get(peer.peerId)?.close();
          links.delete(peer.peerId);
        }
        if (!links.has(peer.peerId)) open(peer);
      }

      // Anything that arrived for somebody we were never offered is not going to become valid.
      for (const peerId of early.keys()) {
        if (!offered.has(peerId)) early.delete(peerId);
      }

      onChange();
    },

    deliver(from: string, description: SignalDescription): void {
      const link = links.get(from);
      if (link) {
        void link.accept(description);
        return;
      }
      const queued = early.get(from) ?? [];
      // One is all that can be useful; a second means the far side has renegotiated past whatever
      // the first described.
      early.set(from, [...queued, description].slice(-1));
    },

    links(): MeshLink[] {
      return [...links.values()].map((link) => ({
        peer: peers.get(link.peerId)!,
        state: link.state,
        ready: link.ready,
      }));
    },

    link(peerId: string): PeerLink | undefined {
      return links.get(peerId);
    },

    viewers(): PeerLink[] {
      return [...links.values()].filter((link) => peers.get(link.peerId)?.recv);
    },

    closeAll(): void {
      for (const link of links.values()) link.close();
      links.clear();
      peers.clear();
      early.clear();
      onChange();
    },
  };
}
