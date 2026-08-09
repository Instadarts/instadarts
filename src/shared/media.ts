// The vocabulary of the optional media feature — what a peer is, who may talk to whom, and how a
// frame is framed. Shared, because the server decides the first two and the clients act on all three.
//
// Three words, kept apart deliberately:
//
//   · **peer**  — one connection taking part in media, addressed by an opaque `peerId` the server
//     mints per socket. Not a session id and not a device id: neither of those should be handed to
//     the person you are playing against.
//   · **roster** — the peers the server offers a given peer. *The roster is the authorization.* A
//     signal is relayed only between two peers the server itself paired, and a peer that vanishes
//     from a roster is a link that closes.
//   · **link**  — one RTCPeerConnection between two peers. It carries **no media tracks**; see
//     below.
//
// ## The two gates
//
// A scoring device is in a roster only when **both** of these are true, and they belong to different
// people:
//
//   1. **The phone is willing** — its own `MediaTier`, set in its settings. This says what the
//      hardware offers. It never says the device is in use, and neither its owner nor the opponent
//      can change it: a camera pointed somewhere its owner would rather not broadcast stays that way.
//   2. **The owner has nominated it** — exactly one of the devices a frontend has claimed may be
//      the **board camera**, or none at all. This is the same picture the opponent sees; nominate
//      nothing and the opponent sees nothing.
//
// So a device that has opted in is not thereby watchable, and a device that has been nominated is
// not thereby willing. Both gates are enforced where every other rule is — in the plan the server
// builds — which is what stops an opponent from reaching a camera nobody offered them.
//
// ## Why there is no video track
//
// Media does not go through WebRTC's media pipeline at all. A peer connection here is pure
// transport: two datachannels, and encoded frames produced by one WebCodecs `VideoEncoder` that the
// mesh owns.
//
// The reason is fan-out. Every RTCPeerConnection encodes its tracks independently, so a scoring
// device with four viewers would run four encoders — on a phone that is already running the
// detection model on its GPU. Encoding once and writing the same chunks to four channels is the
// whole point. (WebRTC Encoded Transform does not help: it hands you frames the browser has
// *already* encoded, so supplying our own bitstream through it would mean encoding twice.)
//
// What that costs is what the media stack does for free — NACK, FEC, PLI and bandwidth estimation.
// The second is moot when the bitrate is fixed by policy. The first is ours to write, and is why the
// two channels below have opposite reliability settings.

// ============================================================
// Peers and rosters
// ============================================================

/** What kind of thing is at the other end. A device only ever publishes; a user may do both. */
export type MediaPeerKind = 'user' | 'device';

/**
 * How much a peer is willing to send.
 *
 * A scoring device's own answer, set on the phone. It says what that hardware is *able and willing*
 * to offer and nothing else — in particular it does **not** say the device is in use. Whether a
 * board camera is actually watched is its owner's separate decision; see
 * [the two gates](#the-two-gates) below.
 *
 * `stills` and `video` do not differ in what the server allows: both open the same link with the
 * same two channels, and the distinction is what a viewer should expect and ask for. Only
 * `disabled` is a rule, and it is a rule about not appearing at all.
 */
export type MediaTier = 'disabled' | 'stills' | 'video';

/**
 * One entry in a peer's roster: somebody it is allowed to open a link to.
 *
 * Both endpoints of a pair are computed from the same plan on the server, so the two can never
 * disagree about whether they are paired, which side is polite, or who may send to whom.
 */
export interface MediaPeer {
  peerId: string;
  kind: MediaPeerKind;
  /** The most this peer will send. Never `disabled` — such a peer is in no roster at all. */
  tier: MediaTier;
  /**
   * The player this peer belongs to, where that is unambiguous — so a viewer can put a board or a
   * face beside the right player card. Absent for a local match's user, who holds every player, and
   * for anyone with no player at all.
   */
  playerId?: string;
  /** What to call it on screen: a device's own name, or a user's player name. */
  label?: string;
  /**
   * Which side takes the polite role in perfect negotiation. Decided by the server rather than by a
   * rule each client applies, so there is no rule for a client to get wrong.
   *
   * The **impolite** side is also the one that opens the two datachannels, and therefore the one
   * that makes the first offer. That is what stops a link's very first negotiation from colliding.
   */
  polite: boolean;
  /**
   * Whether this peer may send media to you. False for a spectator, who only ever watches — and
   * false in a **scoring device's** roster, because a board camera has nothing to do with anybody
   * else's picture and should never decode one.
   */
  send: boolean;
  /**
   * Whether this peer may receive media from you. False for a scoring device, for the same reason,
   * and false when you are a spectator.
   *
   * Both flags are about *media*. The control channel is open in both directions regardless: a
   * viewer has to be able to ask a camera for a keyframe or a still.
   */
  recv: boolean;
}

// ============================================================
// Configuration, as the server hands it out
// ============================================================

/**
 * An ICE server, in a plain shape rather than the DOM's `RTCIceServer` — the server that sends this
 * has no DOM types, and the client is the only side that needs to know it is one.
 */
export interface IceServerConfig {
  urls: string;
  username?: string;
  credential?: string;
}

/**
 * How a publisher encodes. Fixed by the deployment rather than negotiated or adapted: there is no
 * bandwidth estimator to feed one, and adaptive bitrate is deliberately not a feature.
 *
 * Shipped from the server so it can be tuned against real phones without a client release.
 */
export interface VideoProfile {
  /** A WebCodecs codec string. H.264 baseline is the safe floor — every phone encodes it in hardware. */
  codec: string;
  width: number;
  height: number;
  frameRate: number;
  /** Bits per second. */
  bitrate: number;
  /** How often a keyframe goes out regardless of anything asking for one. */
  keyFrameIntervalMs: number;
}

/**
 * What this deployment allows, sent to every connection — frontend and scoring device alike — as
 * soon as it connects. `enabled: false` is sent rather than nothing at all, so a client knows the
 * answer instead of waiting for a message that will never come.
 */
export interface MediaConfig {
  enabled: boolean;
  iceServers: IceServerConfig[];
  video: VideoProfile;
  /** Most peers this connection will ever be offered at once. */
  maxPeers: number;
}

/** The starting point, and only that: measured against real phones is how these numbers get better. */
export const DEFAULT_VIDEO_PROFILE: VideoProfile = {
  codec: 'avc1.42001f', // H.264 baseline, level 3.1
  width: 480,
  height: 480,
  frameRate: 15,
  bitrate: 500_000,
  keyFrameIntervalMs: 2000,
};

// ============================================================
// Signaling
// ============================================================

/**
 * One end of a negotiation. There is no candidate message anywhere in this protocol: a description
 * is not sent until ICE gathering has finished, so it already carries every candidate.
 *
 * That is affordable here because a link has no tracks, which means its SDP is written once and
 * never changes — a link's entire signaling life is one offer and one answer.
 */
export interface SignalDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

/**
 * The most a description may weigh, in bytes.
 *
 * A datachannel-only description is around a kilobyte, plus roughly a hundred bytes per candidate.
 * Eight is generous even on a machine with a dozen interfaces, and a quarter of what one carrying a
 * video m-line would have needed. The socket's own `maxPayload` is 16KB, so this stays clear of it.
 */
export const MAX_SDP_BYTES = 8192;

// ============================================================
// The two channels
// ============================================================

/**
 * A link's channels, named on both sides. The two carry payloads that want opposite guarantees, and
 * that is the whole reason there are two.
 *
 *   · **control** — reliable and ordered. Link control, keyframe requests, and stills: an image that
 *     arrives in pieces is not an image.
 *   · **media** — unreliable and unordered. Encoded video. A frame that is late is worthless, so it
 *     is never waited for; SCTP drops a whole message rather than delivering half of one, which is
 *     exactly the granularity we want — a lost frame, never a corrupt one.
 */
export const CONTROL_CHANNEL = 'control';
export const MEDIA_CHANNEL = 'media';

/** What goes over the control channel. JSON, except for a still's payload, which follows it. */
export type ControlMessage =
  /** Are you there? Answered with `pong`, and the only traffic a link has when nothing is watching. */
  | { kind: 'ping'; seq: number }
  | { kind: 'pong'; seq: number }
  /** The decoder cannot continue from what it has. Send a keyframe. */
  | { kind: 'keyframe' }
  /** A still follows as the next binary message on this channel. */
  | { kind: 'still'; width: number; height: number; mime: string };
