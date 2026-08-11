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
import { CONFIG_DEFAULTS, type ClientConfig, type DartEvidenceConfig, type MediaClientConfig } from '../../shared/config';
import { videoProfile, type VideoProfile } from '../../shared/media';

let current: ClientConfig | null = null;
const listeners = new Set<() => void>();

/** Called by whoever owns the socket, when the server says how it is tuned. */
export function setAppConfig(config: ClientConfig): void {
  current = config;
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

/** How much of the board a dart's evidence shows, and how the feed gets there. */
export function dartEvidence(): DartEvidenceConfig {
  return current?.media.dartEvidence ?? CONFIG_DEFAULTS.media.dartEvidence;
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
