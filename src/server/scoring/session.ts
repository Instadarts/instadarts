// When a camera's tips become darts in a visit, and when a visit ends because the darts came out.
//
// The rules it enforces were arrived at against real players on real boards:
//
//   · **A full visit does NOT submit.** Three darts in the board is not the end of a visit — the
//     player is still standing there, and that gap is exactly when a misread third dart gets fixed.
//     Only a takeout, or the player pressing Submit, ends it.
//   · **Takeout is one empty inference after enough darts, not consecutive empty frames.**
//     Inference is motion-gated, so consecutive empties are the exception; waiting for two would
//     mostly mean waiting forever. A false takeout would need the model to miss every dart at once,
//     in a frame it was confident enough about to solve a homography for.
//   · **An empty board needs unanimity.** One camera reporting nothing is as likely to be a camera
//     that lost the board as a board that lost its darts.
//
//   · **Tracked darts live exactly as long as the visit does, and nothing shorter clears them.**
//     A takeout, a manual Submit, a voided visit — all of them end a visit, and the board is cleared
//     before the next one begins. An empty board that does NOT end the visit leaves them alone,
//     because below the arm threshold we have just said we do not believe the board is empty, and
//     the two ways of being wrong are nothing like equally likely: one inference missing a dart that
//     is still standing in the board is ordinary — it is most of the reason tracking exists at all —
//     while a dart genuinely leaving the board mid-visit needs one to fall out, and only costs
//     anything if the next dart then lands close enough to be taken for the old one. Clearing the
//     tracker on a read we disbelieved buys that rare case by paying a phantom duplicate dart in the
//     common one. The rare case is what manual correction is for.
//
// One departure, because instadarts' server owns the visit where the reference's did not: the visit
// is `match.currentVisit` rather than a local object. Darts go in through the ordinary
// addDartToMatch, so the existing turn check refuses an AI dart out of turn for free, and the
// ordinary broadcast carries it — there is no separate rendering path for a camera dart.
//
// That is also what makes "the visit ended without us" free rather than a mechanism of its own: the
// session watches the match for a visit boundary instead of being told about one, so a manual
// Submit, a voided visit and a leg change are all the same event seen from here.

import type { MatchState } from '../../shared/types';
import { addDartToMatch, submitVisitToMatch } from '../match';
import type { BoardTip } from '../../shared/vision/types';
import { DartTracker } from './tracker';
import { ThrowWindows, type WindowResult } from './throwWindow';

/**
 * Consecutive empty inferences required for a takeout. One, deliberately — inference is
 * motion-gated, so a second empty frame may simply never arrive. Kept named rather than inlined
 * because it is the knob to reach for if takeout ever misfires against a real board.
 */
const EMPTY_INFERENCES_FOR_TAKEOUT = 1;

export interface ScoringSessionOptions {
  /** The match these cameras are watching, or null once it is gone. Re-resolved on every use. */
  getMatch: () => MatchState | null;
  /** Which player the owning frontend controls. Ignored in a local match, where it scores for whoever is up. */
  ownerPlayerId: string | null;
  /** Persist and broadcast a mutated match. */
  commit: (match: MatchState) => void;
}

export class ScoringSession {
  private readonly opts: ScoringSessionOptions;
  private readonly tracker = new DartTracker();
  private readonly windows: ThrowWindows;
  /**
   * Which cameras have most recently reported an empty board. Latched per device, not per window:
   * a takeout needs all of them to agree, and one camera going quiet must not un-say what it said.
   */
  private readonly emptyCameras = new Set<string>();
  private readonly cameras = new Set<string>();
  private consecutiveEmpty = 0;
  /**
   * Which visit we were last tracking, as (visits committed, whose turn). Any change means the
   * visit our darts belonged to is over, whoever ended it.
   */
  private visitMark: string | null = null;

  constructor(opts: ScoringSessionOptions) {
    this.opts = opts;
    this.windows = new ThrowWindows({
      expectedCameras: () => this.cameras.size,
      onClose: (result) => this.onWindow(result),
    });
  }

  /**
   * One inference's board-space tips from one camera. An empty array is the takeout signal.
   *
   * Only a device that has declared its camera active may report: an undeclared device is not in
   * `cameras`, so it is not in `expectedCameras` either, and letting its tips through would mean a
   * board could be called empty by a quorum that never included it.
   */
  addTips(deviceId: string, tips: BoardTip[]): void {
    if (!this.cameras.has(deviceId)) return;
    this.windows.add({ deviceId, tips });
  }

  /** The whole camera roster, as the device registry currently sees it. */
  setCameras(deviceIds: string[]): void {
    const wanted = new Set(deviceIds);
    for (const deviceId of this.cameras) {
      if (!wanted.has(deviceId)) this.setCameraActive(deviceId, false);
    }
    for (const deviceId of wanted) this.setCameraActive(deviceId, true);
  }

  /** A camera started or stopped. Anything that changes the roster lands here. */
  setCameraActive(deviceId: string, active: boolean): void {
    const had = this.cameras.has(deviceId);
    if (active === had) return;
    if (active) this.cameras.add(deviceId);
    else this.cameras.delete(deviceId);

    // "All of them have seen an empty board" is a statement about a different set now, and cannot
    // be carried over.
    this.emptyCameras.clear();
    this.windows.forget(deviceId);
    // A window waiting on a camera that has just left would otherwise sit open until the cap.
    this.windows.recount();
  }

  stop(): void {
    this.windows.stop();
  }

  get cameraCount(): number {
    return this.cameras.size;
  }

  get trackedDarts(): number {
    return this.tracker.count;
  }

  // ============================================================
  // The throw window closed
  // ============================================================

  /**
   * Everything the cameras saw of one throw, fused once. Two separate questions get answered here,
   * and conflating them is the classic way to submit a visit mid-throw:
   *
   *   · **what is new** — the whole window goes to the tracker together, so two views of one dart
   *     make one dart;
   *   · **is the board empty** — which is not "this window had no tips", but "every active camera
   *     has most recently reported nothing".
   */
  private onWindow(result: WindowResult): void {
    // Before anything is attributed, check whether the visit these darts belonged to still exists.
    this.syncVisit();

    for (const report of result.reports) {
      if (report.tips.length === 0) this.emptyCameras.add(report.deviceId);
      else this.emptyCameras.delete(report.deviceId);
    }
    const allEmpty = this.emptyCameras.size >= Math.max(1, this.cameras.size);

    const darts = this.tracker.ingest(result.reports);

    if (allEmpty) {
      // Deliberately no tracker.reset() here. The darts are forgotten when the visit they belong to
      // ends — which syncVisit sees on the next window, submit or no submit.
      this.onEmptyBoard();
      return;
    }

    this.consecutiveEmpty = 0;
    if (darts.length === 0) return;

    const match = this.playableMatch();
    if (!match) return;

    let current = match;
    let changed = false;
    for (const dart of darts) {
      const playerId = this.scoringPlayerId(current);
      if (!playerId) break;
      const before = current.currentVisit?.darts.length ?? 0;
      // A refusal is not a failure: it is not this player's turn, or the visit has no room. Either
      // way the dart stays tracked, so it is never counted twice and never silently forgotten.
      const outcome = addDartToMatch(current, playerId, { x: dart.x, y: dart.y, score: dart.score });
      if (!outcome.success) break;
      const after = outcome.match.currentVisit?.darts.length ?? 0;
      if (after === before) break; // locked: the visit is full or already won
      current = outcome.match;
      changed = true;
    }

    if (changed) this.opts.commit(current);
    // Deliberately no submit here, however full the visit is.
  }

  private onEmptyBoard(): void {
    const match = this.playableMatch();
    if (!match) return;

    const filled = match.currentVisit?.darts.length ?? 0;
    // Nothing to send. This is also the guard that stops a camera pointed at an empty board from
    // playing the match by itself: submitting an empty visit does not error, it commits three
    // misses and advances the turn.
    if (filled === 0) return;
    if (!this.scoringPlayerId(match)) return;

    this.consecutiveEmpty += 1;
    if (this.consecutiveEmpty < EMPTY_INFERENCES_FOR_TAKEOUT) return;
    if (filled < this.armThreshold(match)) return;

    const submitted = submitVisitToMatch(match);
    if (!submitted.success) return;
    this.consecutiveEmpty = 0;
    this.opts.commit(submitted.match);
  }

  /**
   * Notice that the visit moved on, and forget the darts if it did.
   *
   * Tracked darts are per-visit: the board is cleared before the next one starts, so carrying them
   * over would suppress the next player's throw. This is how a manual Submit, a voided visit, a leg
   * change and anything else that ends a visit are handled — by watching the match rather than being
   * told, which means there is no path that can forget to say so.
   */
  private syncVisit(): void {
    const match = this.opts.getMatch();
    // Legs are in the mark explicitly. A leg boundary also empties `visits`, so it would be caught
    // either way — but a boundary is exactly when the board is cleared, and that is worth stating
    // rather than relying on.
    const mark = match
      ? `${match.legs.length}:${match.visits.length}:${match.currentPlayerIndex}:${match.status}`
      : null;
    if (mark === this.visitMark) return;

    const first = this.visitMark === null;
    this.visitMark = mark;
    if (first) return;

    this.tracker.reset();
    this.consecutiveEmpty = 0;
  }

  // ============================================================
  // Who, and when
  // ============================================================

  private playableMatch(): MatchState | null {
    const match = this.opts.getMatch();
    if (!match || match.status !== 'in_progress') return null;
    if (match.players.length === 0) return null;
    return match;
  }

  /**
   * Whose darts these are, or null when they are nobody's.
   *
   * A local match is one board with one frontend scoring for everyone, so the camera scores for
   * whoever is up — the same rule the manual dartboard already follows. An online match has the two
   * players at two different boards, so a camera only ever scores for the frontend that owns it,
   * and only on that player's turn.
   */
  private scoringPlayerId(match: MatchState): string | null {
    const current = match.players[match.currentPlayerIndex];
    if (!current) return null;
    if (match.isLocal) return current.id;
    if (!this.opts.ownerPlayerId || this.opts.ownerPlayerId !== current.id) return null;
    return current.id;
  }

  /**
   * How many darts must be in the visit before an empty board is believed to be a takeout.
   *
   * One camera has to be wrong about two darts at once, so it arms at two. With several cameras an
   * empty board they all agree on is strong enough that one dart is enough. A visit the mode has
   * locked — nothing more may be thrown into it — arms at one either way, because a player in that
   * position pulls their darts early.
   *
   * `locked` is the whole question, and it is the mode's answer. This used to re-derive x01's bust
   * arithmetic here, which meant the camera layer knew what a double-out was.
   */
  private armThreshold(match: MatchState): number {
    if (match.currentVisit?.locked) return 1;
    return this.cameras.size <= 1 ? 2 : 1;
  }
}
