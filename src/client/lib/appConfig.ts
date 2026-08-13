// How this deployment is tuned, as the client sees it.
//
// The settings live in a file the server reads; a browser has none, so it is told — `app_config`,
// once, on connect. This module is where that lands and where everything else reads it from.
//
// **A module-level store rather than React state**, because the readers are not all React. The
// vision runtime, the camera and the still capture are plain modules built once and driven by
// callbacks; threading a prop to them would mean rebuilding them when a value they were built with
// changed. A single place that anything may ask, at the moment it needs an answer, is the shape that
// fits all of them.
//
// **Defaults until the message arrives.** The same defaults the server falls back to, so a client
// that asks early gets the answer it would have got anyway in the overwhelmingly common case — a
// deployment that changed none of them. Media is the exception and stays null-until-told: `enabled`
// is a permission rather than a number, and assuming it before the server has said so would have a
// client announcing itself to a deployment that does not carry media.

import { useSyncExternalStore } from 'react';
import { CONFIG_DEFAULTS, INTERNAL_ICE, type ClientConfig, type DartEvidenceConfig, type MediaClientConfig, type VirtualCameraConfig } from '../../shared/config';
import { videoProfile, type IceServerConfig, type VideoProfile } from '../../shared/media';

let current: ClientConfig | null = null;
const listeners = new Set<() => void>();

/**
 * Turn the `internal` entry into a url, using the one address we know reaches this server: the one
 * this page was loaded from.
 *
 * **The server cannot do this.** It does not know its own public address, and every way of finding
 * out is worse than asking the client — its own interfaces give a LAN address from behind a NAT, an
 * external lookup service would put a third party back into a stack that has none, and the `Host`
 * header is whatever a reverse proxy chose to pass on. The browser, meanwhile, is holding a hostname
 * that demonstrably reaches the server, because it just used it.
 *
 * `location.hostname` brackets an IPv6 literal, which is already the form a STUN uri wants.
 */
function resolveIceServers(servers: IceServerConfig[], stunPort: number | null): IceServerConfig[] {
  return servers.flatMap((server) => {
    if (server.urls !== INTERNAL_ICE) return [server];
    // Dropped rather than guessed at: the server sends null when it has nothing listening, and a
    // url built anyway would point every client at a closed port.
    if (stunPort === null) return [];
    return [{ ...server, urls: `stun:${window.location.hostname}:${stunPort}` }];
  });
}

/**
 * Called by whoever owns the socket, when the server says how it is tuned.
 *
 * ICE is resolved here rather than at each use, so that everything downstream — the mesh, its links,
 * the diagnostics panel — sees one finished list, and so that the memo keying the mesh on that list
 * does not see it change shape.
 */
export function setAppConfig(config: ClientConfig): void {
  current = {
    ...config,
    media: {
      ...config.media,
      iceServers: resolveIceServers(config.media.iceServers, config.media.stunPort),
    },
  };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The media settings, or null until the server has said.
 *
 * Null is meaningful and must not be defaulted away: it is "this client has not been told whether it
 * may carry media", which is not the same as "it may".
 */
export function mediaConfig(): MediaClientConfig | null {
  return current?.media ?? null;
}

/** React's view of the same thing, so a component re-renders when the answer arrives. */
export function useMediaConfig(): MediaClientConfig | null {
  return useSyncExternalStore(subscribe, mediaConfig, () => null);
}

// ============================================================
// The numbers, which always have an answer
// ============================================================

/** Frames a second to ask a camera for. An ideal, never a demand — see `ScorerConfig`. */
export function cameraFrameRate(): number {
  return current?.scorer.cameraFrameRate ?? CONFIG_DEFAULTS.scorer.cameraFrameRate;
}

/** Side of a delivered still, in pixels. Both ends of a link are told the same one. */
export function stillSize(): number {
  return current?.media.still.size ?? CONFIG_DEFAULTS.media.still.size;
}

/** How much of the board a dart's evidence shows, how the feed gets there, and how long it stays. */
export function dartEvidence(): DartEvidenceConfig {
  return current?.media.dartEvidence ?? CONFIG_DEFAULTS.media.dartEvidence;
}

/**
 * What a director command means when it did not say.
 *
 * Read by the receiving device rather than the sender — see `directorTiming`, which takes it as an
 * argument because the module it lives in is shared with a server that has no config to read.
 */
export function virtualCamera(): VirtualCameraConfig {
  return current?.media.virtualCamera ?? CONFIG_DEFAULTS.media.virtualCamera;
}

/**
 * How a publisher encodes.
 *
 * Unlike `mediaConfig`, this always answers: it describes a picture rather than granting permission
 * to send one, so a caller that already has a picture in front of it is entitled to an answer.
 */
export function videoEncoding(): VideoProfile {
  return current?.media.video ?? videoProfile(CONFIG_DEFAULTS.media.video);
}
