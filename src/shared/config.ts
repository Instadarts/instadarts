// Every knob a deployment may turn, and what each one is when it turns none of them.
//
// The values here are the **defaults**. A deployment overrides any of them in one optional file —
// see server/config.ts for where that file is looked for and how it is read. Nothing here is a user
// setting: anything a person can change from the app's own screens belongs in that screen's storage,
// not in a file an operator edits.
//
// Four sections, split by whose knob it is rather than by where the value ends up being used:
//
//   · **server**   the process itself. Never leaves it.
//   · **frontend** the playing browser. Nothing yet — the section exists so the first one has an
//                  obvious home rather than being wedged into a neighbour.
//   · **scorer**   a paired phone watching a board.
//   · **media**    shared by every peer in a match, which is exactly why it cannot be a per-device
//                  setting: two ends of a link have to agree on it.
//
// Three of the four are needed by code running in a browser, which has no file to read — so the
// server reads the file and ships what a client is entitled to as `app_config`, on connect. That is
// what `ClientConfig` below is. The server section is not in it: a browser has no business knowing
// how big the server is.

import type { IceServerConfig, VideoProfile } from './media';

/**
 * The `iceUrls` entry that means "the STUN server this deployment carries of its own".
 *
 * Not a url, because the thing it stands for has no address the server could write down: it answers
 * on whatever host the client reached it at. The client is the one that knows that host, so the
 * client is where this becomes a url — see the resolver in `client/lib/appConfig.ts`.
 */
export const INTERNAL_ICE = 'internal';

/**
 * One of the two ways in the front door.
 *
 * Both listeners answer the same application over the same rules; the only difference is whether
 * the bytes are wrapped in TLS. Either can be turned off, because both are worth turning off in
 * some deployment: behind a reverse proxy that has already terminated TLS, a second handshake here
 * is overhead and nothing else, and on a home network the plain port is the one a phone must not
 * be allowed to reach for the camera.
 */
export interface HttpListenerConfig {
  enabled: boolean;
  port: number;
}

/**
 * The same, plus what it needs to speak TLS.
 *
 * `cert` and `key` are paths, relative to the settings file's own directory or absolute. Naming
 * them is what makes this a deployment's certificate — and leaving them out is not an error but a
 * request: the server makes a self-signed one covering the addresses it is about to bind on, and
 * keeps it beside the settings so a browser only has to be told to trust it once.
 */
export interface HttpsListenerConfig extends HttpListenerConfig {
  cert: string | null;
  key: string | null;
}

/** The process. Read at boot; nothing here can change while it runs. */
export interface ServerConfig {
  http: HttpListenerConfig;
  https: HttpsListenerConfig;
  /**
   * How many matches this deployment is sized for — the one number that scales the server.
   *
   * Everything else the server refuses or evicts by is derived from it in capacity.ts, so this is
   * the only figure to change.
   */
  maxMatches: number;
  /**
   * Most players a match on this server may hold, across all users. Game modes may narrow this for
   * themselves, but no mode may raise it.
   */
  maxPlayersPerMatch: number;
}

/**
 * The playing browser.
 *
 * ⏳ Empty. There is no frontend knob yet; the section is declared so that adding one is adding a
 * field rather than deciding where a whole category lives.
 */
export type FrontendConfig = Record<string, never>;

/** A paired phone watching a board. */
export interface ScorerConfig {
  /**
   * Frames a second to ask the camera for.
   *
   * An `ideal`, never a demand — a camera that cannot do it gives what it can, and the pipeline is
   * driven by the motion gate rather than by the frame rate. Higher costs battery for pictures the
   * gate mostly discards; lower risks a dart landing between two frames.
   */
  cameraFrameRate: number;
}

/** One photograph of a region of the board. The rest of a still — its mime and quality — is not a knob. */
export interface StillConfig {
  /** Side of the delivered image. Square, like the board and like the camera's own capture. */
  size: number;
}

/** How a nominated scorer camera encodes its continuous online-match feed. */
export interface VideoConfig {
  /** Side of the encoded picture, in pixels. Becomes both the width and the height. */
  size: number;
  frameRate: number;
  /** Bits per second. */
  bitrate: number;
}

/**
 * What a director command means when it does not say.
 *
 * The camera has no lens that moves — a shot is a source rectangle eased across one frame — so these
 * are the two numbers that make it read as a camera rather than as a crop jumping about. They are
 * **defaults, not policy**: any command may name its own, and `dartEvidence` below does. This is what
 * a caller with no opinion gets.
 *
 * Read by the **device**, which is the authority on its own camera. See `directorTiming`.
 */
export interface VirtualCameraConfig {
  /**
   * How long the camera takes to reach a shot it was pointed at.
   *
   * `0` is a cut, and is the shipped default: saying nothing about *how* to move means do not move,
   * be there. A caller that wants the move to be seen asks for one.
   */
  transitionMs: number;
  /**
   * How long a shot is held before the camera goes back to the whole board.
   *
   * Deliberately **not** symmetric with the above: saying nothing about how long to stay does not
   * mean stay forever. A director command is fire-and-forget — nothing guarantees a second one is
   * coming — and a camera left framing something the match has moved past is worse than any framing.
   *
   * `0` disables the expiry, so a command that says nothing holds its shot indefinitely. That is the
   * outcome this exists to prevent, so it is a deliberate thing to ask for.
   */
  resetMs: number;
}

/** The close-up under a dart slot. */
export interface DartEvidenceConfig {
  /** How much of the board a dart's evidence shows: enough to see which side of a wire it is on. */
  regionSize: number;
  /**
   * How long the live feed takes to swing onto a dart that has just landed.
   *
   * One caller's override of `virtualCamera.transitionMs`, which is a cut: a camera swinging to a
   * dart reads as somebody looking at it, and that is an evidence decision rather than a video one.
   */
  transitionMs: number;
  /**
   * How long the feed stays on the dart before the camera goes back to the whole board.
   *
   * The other override, and both are said outright rather than left to `virtualCamera` — how long a
   * dart is worth looking at is a question about darts. It matters that this one is said at all,
   * because nothing in the evidence path ever sends a second command to release the camera.
   *
   * `0` means never go back on its own, which here means a camera left zoomed into the 20 bed after
   * the visit has moved on.
   */
  resetMs: number;
}

/** Shared by every peer in a match. */
export interface MediaConfig {
  /**
   * Whether this deployment carries video and stills between the devices in a match.
   *
   * Optional in the strongest sense: off, the server mints no peer ids, publishes no rosters, relays
   * no signals and answers every media message with silence, and neither frontend shows a thing. It
   * is one flag rather than a scattering of checks because a feature that can be half-on is a
   * feature nobody can reason about.
   *
   * Note this is the *deployment's* answer; a browser or a phone may still opt out for itself, which
   * it does by never announcing itself rather than by a second flag.
   */
  enabled: boolean;
  /**
   * Where clients should look for their public address: STUN or TURN urls, and `internal` for the
   * server this deployment carries itself.
   *
   * **`["internal"]` by default**, so nothing about a match leaves the deployment unless somebody
   * asks for it — naming a public STUN server is naming a third party to tell every player's address
   * to. Listing anything here replaces that default and so switches the internal server off, unless
   * `internal` is listed alongside; order is kept, so `["internal", "stun:…"]` means ours first.
   * `[]` means host candidates only: a phone reaches its own frontend across the room, and an
   * opponent in another house reaches nobody.
   *
   * There is no TURN credential handling and no relay of any kind. Where a peer connection cannot be
   * made, the feature is simply unavailable to that user.
   */
  iceUrls: string[];
  /**
   * The UDP port the internal STUN server answers on. Only consulted when `iceUrls` asks for it.
   *
   * 3478 is the number the protocol was assigned and the one a firewall rule is likeliest to already
   * name. It has to be reachable from the clients as UDP, which is the one part of a deployment a
   * reverse proxy will not arrange: proxies forward TCP.
   */
  stunPort: number;
  /** Maximum time the match-entry presentation waits for the optional mesh to settle. */
  setupTimeoutMs: number;
  still: StillConfig;
  video: VideoConfig;
  virtualCamera: VirtualCameraConfig;
  dartEvidence: DartEvidenceConfig;
}

/** The whole file. Every section optional in the file itself; complete once defaults are filled in. */
export interface AppConfig {
  server: ServerConfig;
  frontend: FrontendConfig;
  scorer: ScorerConfig;
  media: MediaConfig;
}

export const CONFIG_DEFAULTS: AppConfig = {
  server: {
    http: { enabled: true, port: 3000 },
    https: { enabled: true, port: 3001, cert: null, key: null },
    maxMatches: 10_000,
    maxPlayersPerMatch: 5,
  },
  frontend: {},
  scorer: {
    cameraFrameRate: 15,
  },
  media: {
    enabled: true,
    iceUrls: [INTERNAL_ICE],
    stunPort: 3478,
    setupTimeoutMs: 4000,
    still: {
      size: 320,
    },
    video: {
      size: 320,
      frameRate: 15,
      bitrate: 500_000,
    },
    virtualCamera: {
      transitionMs: 0,
      resetMs: 2000,
    },
    dartEvidence: {
      regionSize: 0.25,
      transitionMs: 500,
      resetMs: 1000,
    },
  },
};

// ============================================================
// What a client is told
// ============================================================

/**
 * The media section as it reaches a browser: what the file said, plus the things only the server can
 * answer — where the ICE servers are, in the shape the DOM wants, whether the internal one among
 * them actually came up, and how many peers this deployment will offer at once, which comes from its
 * capacity model rather than from the file.
 *
 * `video` arrives as a full `VideoProfile` rather than the file's three numbers: the codec and the
 * keyframe interval are policy that does not vary by deployment, so the server completes the profile
 * on the way out and a publisher receives one finished thing.
 */
export interface MediaClientConfig {
  enabled: boolean;
  setupTimeoutMs: number;
  iceServers: IceServerConfig[];
  /**
   * The port the internal STUN server is answering on, or null if there is none to answer.
   *
   * Null is the whole of how a client learns the server did not come up: the `internal` entry is
   * dropped from `iceServers` at the same time, so a client is never told to use something that is
   * not there.
   */
  stunPort: number | null;
  /** Most peers this connection will ever be offered at once. */
  maxPeers: number;
  still: StillConfig;
  video: VideoProfile;
  /**
   * Sent to every client, though only the **device** reads it: it is the side that receives a
   * director command and has to decide what the numbers it left out meant. The frontend sends its
   * own where it has an opinion — see `dartEvidence`.
   */
  virtualCamera: VirtualCameraConfig;
  dartEvidence: DartEvidenceConfig;
}

/**
 * What the server sends every connection — frontend and scoring device alike — as soon as it
 * arrives, as `app_config`. Sent even when media is off, so a client knows the answer instead of
 * waiting for a message that will never come.
 */
export interface ClientConfig {
  frontend: FrontendConfig;
  scorer: ScorerConfig;
  media: MediaClientConfig;
}
