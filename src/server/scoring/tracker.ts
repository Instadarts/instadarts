// Board-plane tips → darts with numbers on them.
// Ported from dartszentrale-ai-scorer server/dart-tracker.ts.
//
// The camera does the lens, the model and the geometry — everything that is a property of one lens
// on one mount — and hands over a board coordinate. From here on nothing knows or cares which
// camera produced it, with two consequences:
//
//   · A tip becomes a number only AFTER fusion. Scoring happens once, here, on the fused position
//     — never per camera, which is what makes two cameras agreeing on a dart produce one dart.
//   · The repeat filter is keyed by device id, which is the whole mechanism behind cross-camera
//     attach.

import { scoreFromBoardCoords } from '../../shared/scoring';
import type { ScoreResult } from '../../shared/types';
import type { DartPoint } from '../../shared/vision/types';
import { clusterNewTips, filterKnownTips, rankCandidates, type TrackedDart } from './cluster';
import type { TipReport } from './throwWindow';

export interface ScoredDart {
  x: number;
  y: number;
  confidence: number;
  /** How many distinct cameras contributed to this dart. */
  cameraCount: number;
  /** How many tips were fused into it — one camera may contribute more than one. */
  sightings: number;
  score: ScoreResult;
}

export class DartTracker {
  /**
   * Darts already in the board. With a single camera this is the only thing stopping a dart that
   * is still stuck in the board from being counted again on the next motion trigger.
   */
  private tracked: TrackedDart[] = [];

  /**
   * One throw window's worth of tips, from however many cameras reported inside it.
   *
   * **The whole window is fused at once, not camera by camera.** That is the difference between
   * two cameras seeing one dart and two cameras producing two darts: `filterKnownTips` runs over
   * every tip together, so a tip from a camera that has not yet observed a known dart attaches to
   * it rather than spawning a second one.
   *
   * Candidates come back ranked, because with three slots and possibly more candidates than that,
   * the order decides which darts get in.
   */
  ingest(reports: TipReport[]): ScoredDart[] {
    const points: DartPoint[] = reports.flatMap((report) =>
      report.tips.map((tip) => ({
        x: tip.x,
        y: tip.y,
        confidence: tip.confidence,
        deviceId: report.deviceId,
      })),
    );

    const { survivors, tracked } = filterKnownTips(points, this.tracked);
    this.tracked = tracked;

    const fresh: ScoredDart[] = [];
    for (const candidate of clusterNewTips(survivors).sort(rankCandidates)) {
      this.tracked.push({
        x: candidate.x,
        y: candidate.y,
        confidence: candidate.confidence,
        observations: candidate.observations,
      });
      fresh.push({
        x: candidate.x,
        y: candidate.y,
        confidence: candidate.confidence,
        cameraCount: candidate.cameraCount,
        sightings: candidate.observations.length,
        score: scoreFromBoardCoords(candidate.x, candidate.y),
      });
    }
    return fresh;
  }

  /** Forget the darts in the board. Only an empty board may call this — see ScoringSession. */
  reset(): void {
    this.tracked = [];
  }

  get count(): number {
    return this.tracked.length;
  }
}
