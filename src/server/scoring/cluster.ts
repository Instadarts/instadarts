// Which tips are the same dart.
//
// Kept whole, including the cross-camera attach path a single camera never exercises: it is the
// fusion a second camera needs, and deleting it would be the one simplification that is expensive
// to undo. A tip's camera key is its device id outright — every tip here
// arrives from an authenticated scoring device, so there is no null case to defend against.

import { THROW_WINDOW_DART_RADIUS, REPEAT_FILTER_RADIUS } from '../../shared/vision/constants';
import type { DartPoint } from '../../shared/vision/types';

/**
 * A dart already in the board this visit. The submitted coordinate is the winning
 * (highest-confidence) observation's position; every per-camera sighting is retained so later
 * windows can recognise re-sightings of this same dart, per camera.
 */
export interface TrackedDart {
  x: number;
  y: number;
  confidence: number;
  observations: DartPoint[];
}

/**
 * A new dart found within one throw window. The representative coordinate is the seed
 * (highest-confidence) tip — no centroid averaging, so the submitted position is a real
 * observation rather than a point nobody saw.
 */
export interface DartCandidate {
  x: number;
  y: number;
  confidence: number;
  observations: DartPoint[];
  /** Number of distinct cameras that contributed. */
  cameraCount: number;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Inter-window step (runs first). Drops tips that are re-sightings of darts already tracked, and
 * attaches tips from a camera newly seeing a known dart onto that dart's record. Whatever survives
 * is assumed genuinely new — even if it lands close to an existing dart.
 *
 * Tips are processed confidence-first so the strongest observation wins any attach race. The input
 * array is not mutated.
 */
export function filterKnownTips(
  tips: DartPoint[],
  tracked: TrackedDart[],
): { survivors: DartPoint[]; tracked: TrackedDart[] } {
  const next: TrackedDart[] = tracked.map((d) => ({ ...d, observations: [...d.observations] }));
  const survivors: DartPoint[] = [];

  const sorted = [...tips].sort((a, b) => b.confidence - a.confidence);

  for (const tip of sorted) {
    // Same-camera repeat: this camera already saw this dart → drop.
    const isRepeat = next.some((d) =>
      d.observations.some(
        (o) => o.deviceId === tip.deviceId && distance(tip.x, tip.y, o.x, o.y) < REPEAT_FILTER_RADIUS,
      ),
    );
    if (isRepeat) continue;

    // Cross-camera attach: a camera that has not observed a known dart, landing near it, is seeing
    // that known dart for the first time → attach, don't spawn.
    let attachTo: TrackedDart | null = null;
    let attachDist = Infinity;
    for (const d of next) {
      if (d.observations.some((o) => o.deviceId === tip.deviceId)) continue;
      const dist = distance(tip.x, tip.y, d.x, d.y);
      if (dist < THROW_WINDOW_DART_RADIUS && dist < attachDist) {
        attachTo = d;
        attachDist = dist;
      }
    }
    if (attachTo) {
      attachTo.observations.push(tip);
      continue;
    }

    survivors.push(tip);
  }

  return { survivors, tracked: next };
}

/**
 * Intra-window step. Groups surviving tips by proximity using a fixed seed anchor: tips are
 * processed confidence-first, each unclaimed tip seeds a candidate, and the rest attach to the
 * nearest seed within THROW_WINDOW_DART_RADIUS.
 */
export function clusterNewTips(survivors: DartPoint[]): DartCandidate[] {
  const sorted = [...survivors].sort((a, b) => b.confidence - a.confidence);
  const candidates: DartCandidate[] = [];

  for (const tip of sorted) {
    let nearest: DartCandidate | null = null;
    let nearestDist = Infinity;
    for (const c of candidates) {
      const dist = distance(tip.x, tip.y, c.x, c.y);
      if (dist < THROW_WINDOW_DART_RADIUS && dist < nearestDist) {
        nearest = c;
        nearestDist = dist;
      }
    }

    if (nearest) {
      nearest.observations.push(tip);
    } else {
      candidates.push({
        x: tip.x,
        y: tip.y,
        confidence: tip.confidence,
        observations: [tip],
        cameraCount: 0, // finalised below
      });
    }
  }

  for (const c of candidates) {
    c.cameraCount = new Set(c.observations.map((o) => o.deviceId)).size;
  }

  return candidates;
}

/**
 * Rank candidates best-first: more cameras agreeing wins, then higher seed confidence, then
 * tighter grouping. With three slots and possibly more candidates than that, this order decides
 * which darts get in.
 */
export function rankCandidates(a: DartCandidate, b: DartCandidate): number {
  if (b.cameraCount !== a.cameraCount) return b.cameraCount - a.cameraCount;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  return spread(a) - spread(b);
}

function spread(c: DartCandidate): number {
  return c.observations.reduce((max, o) => Math.max(max, distance(o.x, o.y, c.x, c.y)), 0);
}
