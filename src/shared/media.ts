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
   * This peer and you belong to the same user: a scoring device and the frontend that claimed it.
   *
   * True on exactly one edge per device and false everywhere else — never for an opponent, never for
   * a spectator. It carries the ownership relationship into the roster, and does two jobs that both
   * need doing:
   *
   *   · a **device** honours a command only from the peer marked `own`, which is what stops an
   *     opponent deciding what somebody else's camera photographs;
   *   · a **frontend** finds its own board camera by it, since a roster addresses peers by opaque id
   *     and `playerId` has no answer in a local match.
   *
   * This is "the roster is the authorization" widened from who may *connect* to who may *command*.
   */
  own: boolean;
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
  width: 320,
  height: 320,
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

/**
 * What goes over the control channel.
 *
 * Everything here travels as JSON, except a still — which is one self-describing binary message
 * carrying this header *and* its bytes together. See `frames.ts`: a header sent as its own message
 * and paired with "the next binary one" stops working the moment two stills are in flight, which
 * with three darts landing at once is an ordinary Tuesday.
 */
export type ControlMessage =
  /** Are you there? Answered with `pong`, and the only traffic a link has when nothing is watching. */
  | { kind: 'ping'; seq: number }
  | { kind: 'pong'; seq: number }
  /**
   * The decoder cannot continue from what it has. Send a keyframe.
   *
   * **The one command any viewer may send**, and the exception is deliberate: a keyframe changes
   * nothing about *what* is shown, only about whether the asker can decode it. An opponent gains no
   * say over somebody else's camera by being able to say "I cannot read this". The device
   * rate-limits instead, so four viewers cannot cost four keyframes — see `VIDEO`.
   */
  | { kind: 'keyframe' }
  /**
   * Photograph this part of your board and send it back.
   *
   * Honoured only from a peer the roster marks `own` — see MediaPeer. Anyone else gets silence.
   */
  | { kind: 'still_request'; id: string; region?: Region; tag?: unknown }
  /** The header of a still frame; the JPEG bytes travel in the same message. */
  | { kind: 'still'; id: string; tag?: unknown; width: number; height: number; mime: string }
  | { kind: 'still_refused'; id: string; reason: StillRefusal }
  /**
   * Start publishing live video, and stop.
   *
   * Deliberately without a region: starting a feed and framing it are different decisions, and only
   * the second is a `video_region`. Owner-only, like every command but `keyframe`.
   */
  | { kind: 'video_start' }
  | { kind: 'video_stop' }
  /**
   * Point the camera at this square of the board, over this long.
   *
   * The **director** command — the same region vocabulary a still uses, plus the one thing a moving
   * picture needs that a photograph does not: how long to take getting there. A cut is
   * `transitionMs: 0`; anything else is a move.
   */
  | { kind: 'video_region'; region: Region; transitionMs?: number }
  /**
   * Whether this camera is publishing, told to every viewer rather than only to whoever asked.
   *
   * A spectator never sent `video_start` and would otherwise have no way to tell a feed that is off
   * from a link that is broken — both are a black rectangle.
   */
  | { kind: 'video_state'; on: boolean; reason?: VideoRefusal };

/**
 * Why a camera could not answer.
 *
 * Only ever sent to the peer that asked, and only for a request it was entitled to make: an
 * unauthorized one is not refused, it is ignored.
 */
export type StillRefusal =
  /** No camera running, so there is no picture to take. */
  | 'no_frame'
  /** Nothing to place the region against — the board has not been located since the camera started. */
  | 'not_located'
  /** Too many already in hand. */
  | 'busy';

/**
 * Why a camera is not publishing video.
 *
 * Unlike `StillRefusal` this is not an answer to a request — it rides on `video_state`, which goes to
 * everybody watching, because "there is no picture and here is why" is as useful to a spectator as to
 * the owner who asked.
 *
 * There is deliberately no `not_located`: a feed does not need the board to be found. It falls back
 * to the camera's own square and upgrades itself when a homography turns up.
 */
export type VideoRefusal =
  /** This device's tier is not `video`. Its owner said stills, or nothing. */
  | 'not_offered'
  /** No camera running. */
  | 'no_camera'
  /** This browser has no usable `VideoEncoder` — Safari before 16.4, and anything older still. */
  | 'no_encoder';

// ============================================================
// Regions of a board
// ============================================================

/**
 * A square of **normalized board space** — the coordinate system everything here already shares,
 * scaled to [0,1]. `{ cx: 0.5, cy: 0.5, size: 1 }` is the whole board, and is what no region means.
 *
 * Board space rather than anything about a camera, so that a request says *what to look at* and
 * never *where to point*. The same region means the same thing from any camera, and the asking side
 * needs to know nothing about lenses, mounts or angles — the device owns all of that and maps the
 * region into its own frame with the homography it already solves every inference.
 */
export interface Region {
  cx: number;
  cy: number;
  /** Side length. One number: the board is square and so is every still. */
  size: number;
}

export const DEFAULT_REGION: Region = { cx: 0.5, cy: 0.5, size: 1 };

/**
 * The smallest square worth asking for. A crop below this is mostly enlargement artefact — there
 * are only so many real pixels on a phone pointed at a board a metre away.
 */
export const MIN_REGION_SIZE = 0.05;

/**
 * A region as the capturing device will actually read it.
 *
 * **The device is the authority**, and runs this over anything that arrives however friendly the
 * sender looked — a region is a number from another machine. The requester runs it too, so that what
 * it drew on screen and what comes back are the same square.
 *
 * A region that would fall off the edge has its centre **moved towards the middle** rather than
 * being rejected or having its size cut: a dart in the 20 bed is near the top, and the useful answer
 * is the closest square that still holds it, not an error. So `{0.5, 1, 1}` becomes `{0.5, 0.5, 1}`.
 */
export function clampRegion(region: Region | undefined): Region {
  if (!region) return DEFAULT_REGION;
  const { cx, cy, size } = region;
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(size)) return DEFAULT_REGION;

  const side = Math.min(Math.max(size, MIN_REGION_SIZE), 1);
  const half = side / 2;
  return {
    cx: Math.min(Math.max(cx, half), 1 - half),
    cy: Math.min(Math.max(cy, half), 1 - half),
    size: side,
  };
}

// ============================================================
// Stills
// ============================================================

/**
 * Every still, whatever it was asked for and whoever asked.
 *
 * Not shipped from the server like `VideoProfile`, and should not be: a still never touches the
 * server. Both ends of a link are the same build from the same origin, so a shared constant is the
 * honest place for a number the two of them have to agree on.
 */
export const STILL = {
  /** Side of the delivered image. Square, like the board and like the camera's own capture. */
  size: 320,
  mime: 'image/jpeg',
  quality: 0.65,
} as const;

/** How much of the board a dart's evidence shows: enough to see which side of a wire it is on. */
export const DART_EVIDENCE_REGION_SIZE = 0.25;

/**
 * Requests a camera will hold at once before refusing.
 *
 * More than one because a fused camera report can commit three darts in a single moment, and three
 * requests arriving together is the normal case rather than an attack. They share one video frame
 * and cost three crops, which is nothing.
 */
export const MAX_PENDING_STILLS = 4;

// ============================================================
// Live video
// ============================================================

/**
 * The numbers a publisher runs by, in the same single place as `STILL` and for the same reason: both
 * ends of a link are one build from one origin, so a shared constant is honest where a negotiation
 * would be theatre.
 *
 * The size, rate and bitrate are **not** here — those are `VideoProfile`, shipped by the server, so a
 * deployment can be retuned against real phones without a client release. What is here is policy that
 * does not vary by deployment.
 */
export const VIDEO = {
  /**
   * Stop writing to a link that already has this much queued.
   *
   * **Drop, never queue.** A frame that has not left yet is worth less than the one behind it, and a
   * datachannel with no bandwidth estimator will happily grow a buffer until the picture is a minute
   * behind the board. Roughly a quarter-second at the default bitrate, which is about as far behind
   * as a live board may fall before it stops being live.
   */
  maxBufferedBytes: 16_384,
  /**
   * The most often a viewer's asking can actually produce a keyframe.
   *
   * Anyone may ask (see `keyframe`), and several viewers losing the same frame will all ask at once.
   * Answering each of them costs everyone bandwidth, since a keyframe goes to every viewer.
   */
  keyframeMinIntervalMs: 500,
  /** How long a director's move takes when the command does not say. */
  defaultTransitionMs: 500,
  /**
   * A frame larger than this is dropped rather than sent.
   *
   * SCTP interop, not our policy: implementations differ on how large a datachannel message may be,
   * and 64KB is the size everything agrees on. At this profile nothing should come close — a frame
   * that does is a symptom, and dropping it beats killing the channel.
   */
  maxFrameBytes: 65_536,
} as const;
