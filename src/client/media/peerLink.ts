// One peer connection, and the whole of what it takes to open one.
//
// No React, no app vocabulary, nothing about darts. It is handed a peer's id, whether it is the
// polite one, and a way to send a description; it produces a connected pair of datachannels.
//
// ## Two things here are not the usual WebRTC recipe
//
// **A description is not sent until ICE gathering has finished.** The ordinary pattern trickles
// candidates as they arrive, which means a message per candidate and a signaling server that has to
// relay them. Waiting instead folds every candidate into the one description, so a link's entire
// signaling life is one offer and one answer — see shared/media.ts for why that is affordable. With
// no STUN configured, gathering finishes in milliseconds; the timeout below is what bounds a
// configured STUN server that is slow or gone.
//
// **There are no media tracks.** Media travels as encoded chunks over the channels. The
// renegotiation machinery below is therefore never triggered by anything in this app — it is kept
// deliberately, because it is what a video track would need if WebCodecs ever disappoints on a real
// phone, and it is far cheaper to keep thirty lines than to reason them out again later.

import type { ControlMessage, IceServerConfig, SignalDescription } from '../../shared/media';
import { CONTROL_CHANNEL, FALLBACK_MAX_MESSAGE_BYTES, MEDIA_CHANNEL } from '../../shared/media';
import { packFrame, unpackFrame } from './frames';

/**
 * How long to wait for ICE gathering before sending what we have.
 *
 * Not a latency budget — with host candidates only this never fires. It exists so that one
 * unreachable STUN server cannot hold a link open indefinitely, since a description with the
 * candidates we already had is worth far more than a complete one that never arrives.
 */
const GATHER_TIMEOUT_MS = 2000;

export type LinkState = 'new' | 'connecting' | 'connected' | 'failed' | 'closed';

export interface PeerLinkOptions {
  peerId: string;
  /**
   * Which side yields in a collision, decided by the server so neither client has a rule to get
   * wrong. The **impolite** side also opens the channels, and so makes the first offer — which is
   * what stops a link's very first negotiation from colliding with itself.
   */
  polite: boolean;
  iceServers: IceServerConfig[];
  /** Hand one end of a negotiation to this peer, by whatever route the app has. */
  signal: (description: SignalDescription) => void;
  /**
   * Something about this link changed — its connection state, or whether its channels are open.
   *
   * The two are deliberately one callback, because they are not the same event and both matter: a
   * link reports `connected` a moment before its datachannels finish opening, so anything that
   * waits only on the connection state will find a link it cannot yet write to.
   */
  onChange: (state: LinkState) => void;
  /**
   * A control-channel message, already parsed. `payload` is present only for the kinds that carry
   * bytes — a still — and arrives in the same message as its header, never separately.
   */
  onControl: (message: ControlMessage, payload?: Uint8Array) => void;
  /** One encoded chunk off the media channel. */
  onMedia: (data: ArrayBuffer) => void;
}

export interface PeerLink {
  readonly peerId: string;
  readonly state: LinkState;
  /** Whether both channels are open and writable. */
  readonly ready: boolean;
  /** How much is queued on the media channel — the only backpressure signal there is. */
  readonly bufferedAmount: number;
  /**
   * The largest single message this peer agreed to receive, as the two ends negotiated it.
   *
   * Read rather than assumed, because a keyframe is the biggest thing this app sends and the
   * conservative floor is smaller than one. See `FALLBACK_MAX_MESSAGE_BYTES`.
   */
  readonly maxMessageBytes: number;
  /** A description has arrived from this peer. */
  accept(description: SignalDescription): Promise<void>;
  /**
   * Send a control message, with bytes attached for the kinds that carry them.
   *
   * Reports whether it actually went. A channel that is not open yet drops the message, and a caller
   * that records "asked" regardless will wait forever for an answer to a question nobody heard. So
   * does one over the negotiated limit — a still is the only control message with real weight, and
   * the same rule applies to it as to a frame.
   */
  sendControl(message: ControlMessage, payload?: Uint8Array): boolean;
  /**
   * Send one encoded chunk, and report whether it went.
   *
   * A message over the negotiated limit is refused here rather than handed to the channel: that
   * throws, and losing the channel costs far more than losing the frame.
   */
  sendMedia(chunk: ArrayBufferView | ArrayBuffer): boolean;
  close(): void;
  /** What the connection actually settled on, for the diagnostics panel. */
  stats(): Promise<LinkStats>;
}

export interface LinkStats {
  /** How the two ends found each other: `host` on a LAN, `srflx` through a NAT. */
  localCandidateType?: string;
  remoteCandidateType?: string;
  bytesSent?: number;
  bytesReceived?: number;
  currentRoundTripTime?: number;
}

export function createPeerLink(options: PeerLinkOptions): PeerLink {
  const { peerId, polite, iceServers, signal, onChange, onControl, onMedia } = options;

  const pc = new RTCPeerConnection({
    iceServers: iceServers.map((s) => ({ urls: s.urls, username: s.username, credential: s.credential })),
  });

  let state: LinkState = 'new';
  let control: RTCDataChannel | null = null;
  let media: RTCDataChannel | null = null;

  // Perfect negotiation's two flags. `makingOffer` is set around setLocalDescription because
  // gathering means we sit in that window for a while, which is exactly when a collision happens.
  let makingOffer = false;
  let ignoreOffer = false;

  function setState(next: LinkState): void {
    if (state === next || state === 'closed') return;
    state = next;
    onChange(next);
  }

  /**
   * Read through a call rather than testing the variable directly.
   *
   * Every use below sits after an `await`, which is the whole point of asking — gathering takes
   * long enough for a link to be closed underneath it. A direct comparison would be narrowed away
   * by the compiler, which cannot see that the value moves while the function is suspended.
   */
  const isClosed = (): boolean => state === 'closed';

  /**
   * The local description, once every candidate is in it.
   *
   * `pc.localDescription` is a live object, so reading it after gathering completes yields the SDP
   * with the candidate lines appended — which is the whole trick that removes candidate messages
   * from the protocol.
   */
  async function gathered(): Promise<RTCSessionDescription> {
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const finish = () => {
          pc.removeEventListener('icegatheringstatechange', check);
          clearTimeout(timer);
          resolve();
        };
        const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
        const timer = setTimeout(finish, GATHER_TIMEOUT_MS);
        pc.addEventListener('icegatheringstatechange', check);
      });
    }
    return pc.localDescription!;
  }

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      const description = await gathered();
      // Between the await above and here the link may have been closed, or a rollback may have moved
      // us on. Sending a description for a state we have left is worse than sending nothing.
      if (isClosed() || pc.signalingState !== 'have-local-offer') return;
      signal({ type: 'offer', sdp: description.sdp });
    } catch {
      // A failed negotiation is a link that does not come up. The state below reports it; there is
      // nothing here that retrying would fix.
    } finally {
      makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => {
    switch (pc.connectionState) {
      case 'connecting': setState('connecting'); break;
      case 'connected': setState('connected'); break;
      // `disconnected` is not failure — it is ICE saying it has lost sight of the other end, and it
      // recovers on its own more often than not. Only `failed` is final.
      case 'failed': setState('failed'); break;
      case 'closed': setState('closed'); break;
    }
  };

  function bindControl(channel: RTCDataChannel): void {
    control = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => onChange(state);
    channel.onclose = () => onChange(state);
    channel.onmessage = (event) => {
      // Anything unreadable is dropped rather than thrown: this is data from another machine, and
      // one bad message must not take the channel down with it.
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as ControlMessage;
          if (typeof message?.kind === 'string') onControl(message);
        } catch { /* not ours */ }
        return;
      }
      const frame = unpackFrame(event.data as ArrayBuffer);
      if (frame) onControl(frame.header, frame.payload);
    };
  }

  function bindMedia(channel: RTCDataChannel): void {
    media = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => onChange(state);
    channel.onclose = () => onChange(state);
    channel.onmessage = (event) => onMedia(event.data as ArrayBuffer);
  }

  if (!polite) {
    // The impolite side opens both, which is what fires its `negotiationneeded` and makes it the
    // one that offers. Datachannels are negotiated in-band over SCTP rather than in the SDP, so
    // opening them costs nothing extra in the description.
    bindControl(pc.createDataChannel(CONTROL_CHANNEL, { ordered: true }));
    // Unreliable and unordered, deliberately: a late frame is worthless, and SCTP drops a whole
    // message rather than delivering half of one — a lost frame, never a corrupt one.
    bindMedia(pc.createDataChannel(MEDIA_CHANNEL, { ordered: false, maxRetransmits: 0 }));
  } else {
    pc.ondatachannel = (event) => {
      if (event.channel.label === CONTROL_CHANNEL) bindControl(event.channel);
      else if (event.channel.label === MEDIA_CHANNEL) bindMedia(event.channel);
    };
  }

  async function accept(description: SignalDescription): Promise<void> {
    if (isClosed()) return;
    try {
      // The collision window: an offer arriving while we are mid-offer, or while our own is still
      // on the wire. The impolite side ignores it and expects the other to yield; the polite side
      // yields, which `setRemoteDescription` does for it by rolling back implicitly.
      const collision = description.type === 'offer'
        && (makingOffer || pc.signalingState !== 'stable');
      ignoreOffer = !polite && collision;
      if (ignoreOffer) return;

      await pc.setRemoteDescription(description);
      if (description.type !== 'offer') return;

      await pc.setLocalDescription();
      const answer = await gathered();
      if (isClosed()) return;
      signal({ type: 'answer', sdp: answer.sdp });
    } catch {
      // Malformed or out-of-order: the link simply does not come up, and the state says so.
    }
  }

  function close(): void {
    setState('closed');
    control?.close();
    media?.close();
    pc.close();
  }

  // The transport does not exist until the connection does, so this is asked each time rather than
  // read once at construction.
  const maxMessageBytes = (): number => pc.sctp?.maxMessageSize ?? FALLBACK_MAX_MESSAGE_BYTES;

  return {
    peerId,
    get state() { return state; },
    get ready() {
      return control?.readyState === 'open' && media?.readyState === 'open';
    },
    get bufferedAmount() { return media?.bufferedAmount ?? 0; },
    get maxMessageBytes() { return maxMessageBytes(); },
    accept,
    sendControl(message: ControlMessage, payload?: Uint8Array): boolean {
      if (control?.readyState !== 'open') return false;
      if (!payload) {
        // Every one of these is a short line of JSON. Nothing here approaches a message limit, and
        // measuring the UTF-8 length of one to prove it would cost more than it could ever save.
        control.send(JSON.stringify(message));
        return true;
      }
      const frame = packFrame(message, payload);
      // Guarded like a video frame, and for a sharper reason: `send` throws over the limit, and this
      // one is called from inside a loop over every viewer, so the throw would come out of the middle
      // of a still's fan-out and cut off everybody after the first.
      if (frame.byteLength > maxMessageBytes()) return false;
      control.send(frame);
      return true;
    },
    sendMedia(chunk: ArrayBufferView | ArrayBuffer): boolean {
      if (media?.readyState !== 'open') return false;
      if (chunk.byteLength > maxMessageBytes()) return false;
      media.send(chunk as ArrayBuffer);
      return true;
    },
    close,
    async stats(): Promise<LinkStats> {
      const report = await pc.getStats();
      let pair: RTCIceCandidatePairStats | undefined;
      for (const entry of report.values()) {
        if (entry.type === 'candidate-pair' && (entry as RTCIceCandidatePairStats).nominated) {
          pair = entry as RTCIceCandidatePairStats;
        }
      }
      if (!pair) return {};
      const local = report.get(pair.localCandidateId ?? '');
      const remote = report.get(pair.remoteCandidateId ?? '');
      return {
        localCandidateType: local?.candidateType,
        remoteCandidateType: remote?.candidateType,
        bytesSent: pair.bytesSent,
        bytesReceived: pair.bytesReceived,
        currentRoundTripTime: pair.currentRoundTripTime,
      };
    },
  };
}
