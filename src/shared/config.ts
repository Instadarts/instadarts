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

/** The process. Read at boot; nothing here can change while it runs. */
export interface ServerConfig {
  port: number;
  /**
   * How many matches this deployment is sized for — the one number that scales the server.
   *
   * Everything else the server refuses or evicts by is derived from it in capacity.ts, so this is
   * the only figure to change.
   */
  maxMatches: number;
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

/** How a publisher encodes. Square, like everything else a camera sends. */
export interface VideoConfig {
  /** Side of the encoded picture, in pixels. Becomes both the width and the height. */
  size: number;
  frameRate: number;
  /** Bits per second. */
  bitrate: number;
}

/** The close-up under a dart slot. */
export interface DartEvidenceConfig {
  /** How much of the board a dart's evidence shows: enough to see which side of a wire it is on. */
  regionSize: number;
  /**
   * How long the live feed takes to swing onto a dart that has just landed.
   *
   * An evidence decision rather than a video policy: the feed's own default is a cut, and this is
   * one caller asking for a move because a camera swinging to a dart reads as somebody looking at it.
   */
  transitionMs: number;
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
  still: StillConfig;
  video: VideoConfig;
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
    port: 3000,
    maxMatches: 10_000,
  },
  frontend: {},
  scorer: {
    cameraFrameRate: 15,
  },
  media: {
    enabled: true,
    iceUrls: [INTERNAL_ICE],
    stunPort: 3478,
    still: {
      size: 320,
    },
    video: {
      size: 320,
      frameRate: 15,
      bitrate: 500_000,
    },
    dartEvidence: {
      regionSize: 0.25,
      transitionMs: 500,
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
