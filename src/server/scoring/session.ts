// When a camera's tips become darts in a visit, and when a visit ends because the darts came out.
//
// Ported from dartszentrale-ai-scorer's src/visit/visit-controller.ts plus the camera half of
// server/visit-host.ts. The rules it enforces are theirs, field-proven:
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
//   · **Tracked darts live exactly as long as the visit does.** Anything that ends a visit forgets
//     them — a takeout, a manual Submit, a bust — because the board is cleared before the next one
//     begins. The empty-board signal clears them too, for the visit that is still in progress when
//     a player pulls a single dart back out.
//
// One departure, because instadarts' server owns the visit where the reference's did not: the visit
// is `game.currentVisit` rather than a local object. Darts go in through the ordinary
// addDartToGame, so the existing turn check refuses an AI dart out of turn for free, and the
// ordinary broadcast carries it — there is no separate rendering path for a camera dart.
//
// That is also what makes "the visit ended without us" free rather than a mechanism of its own: the
// session watches the game for a visit boundary instead of being told about one, so a manual
// Submit, a bust and a leg change are all the same event seen from here.

import type { GameState } from '../../shared/types';
import { addDartToGame, submitVisitToGame } from '../game';
import { getModeHandler } from '../modes/types';
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
  /** The game these cameras are watching, or null once it is gone. Re-resolved on every use. */
  getGame: () => GameState | null;
  /** Which player the owning frontend controls. Ignored in a local match, where it scores for whoever is up. */
  ownerPlayerId: string | null;
  /** Persist and broadcast a mutated game. */
  commit: (game: GameState) => void;
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
      // The board is empty, so nothing is in it — whatever happens to the visit below, the darts
      // this tracker was suppressing are gone.
      this.tracker.reset();
      this.onEmptyBoard();
      return;
    }

    this.consecutiveEmpty = 0;
    if (darts.length === 0) return;

    const game = this.playableGame();
    if (!game) return;

    let current = game;
    let changed = false;
    for (const dart of darts) {
      const playerId = this.scoringPlayerId(current);
      if (!playerId) break;
      const before = current.currentVisit?.darts.length ?? 0;
      // A refusal is not a failure: it is not this player's turn, or the visit has no room. Either
      // way the dart stays tracked, so it is never counted twice and never silently forgotten.
      const outcome = addDartToGame(current, playerId, { x: dart.x, y: dart.y, score: dart.score });
      if (!outcome.success) break;
      const after = outcome.game.currentVisit?.darts.length ?? 0;
      if (after === before) break; // locked: the visit is full or already won
      current = outcome.game;
      changed = true;
    }

    if (changed) this.opts.commit(current);
    // Deliberately no submit here, however full the visit is.
  }

  private onEmptyBoard(): void {
    const game = this.playableGame();
    if (!game) return;

    const filled = game.currentVisit?.darts.length ?? 0;
    // Nothing to send. This is also the guard that stops a camera pointed at an empty board from
    // playing the match by itself: submitting an empty visit does not error, it commits three
    // misses and advances the turn.
    if (filled === 0) return;
    if (!this.scoringPlayerId(game)) return;

    this.consecutiveEmpty += 1;
    if (this.consecutiveEmpty < EMPTY_INFERENCES_FOR_TAKEOUT) return;
    if (filled < this.armThreshold(game)) return;

    const submitted = submitVisitToGame(game);
    if (!submitted.success) return;
    this.consecutiveEmpty = 0;
    this.opts.commit(submitted.result.game);
  }

  /**
   * Notice that the visit moved on, and forget the darts if it did.
   *
   * Tracked darts are per-visit: the board is cleared before the next one starts, so carrying them
   * over would suppress the next player's throw. This is how a manual Submit, a bust, a leg change
   * and anything else that ends a visit are all handled — by watching the game rather than by being
   * told, which means there is no path that can forget to say so.
   */
  private syncVisit(): void {
    const game = this.opts.getGame();
    const mark = game ? `${game.visits.length}:${game.currentPlayerIndex}:${game.status}` : null;
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

  private playableGame(): GameState | null {
    const game = this.opts.getGame();
    if (!game || game.status !== 'in_progress') return null;
    if (game.players.length === 0) return null;
    return game;
  }

  /**
   * Whose darts these are, or null when they are nobody's.
   *
   * A local match is one board with one frontend scoring for everyone, so the camera scores for
   * whoever is up — the same rule the manual dartboard already follows. An online match has the two
   * players at two different boards, so a camera only ever scores for the frontend that owns it,
   * and only on that player's turn.
   */
  private scoringPlayerId(game: GameState): string | null {
    const current = game.players[game.currentPlayerIndex];
    if (!current) return null;
    if (game.isLocal) return current.id;
    if (!this.opts.ownerPlayerId || this.opts.ownerPlayerId !== current.id) return null;
    return current.id;
  }

  /**
   * How many darts must be in the visit before an empty board is believed to be a takeout.
   *
   * One camera has to be wrong about two darts at once, so it arms at two. With several cameras an
   * empty board they all agree on is strong enough that one dart is enough. A visit that is already
   * over — locked by a checkout, or arithmetically bust — arms at one either way, because a player
   * in that position pulls their darts early.
   */
  private armThreshold(game: GameState): number {
    if (game.currentVisit?.locked) return 1;
    if (this.isAlreadyBust(game)) return 1;
    return this.cameras.size <= 1 ? 2 : 1;
  }

  /** Only busts that are arithmetically certain from the total; anything subtler is not ours to call. */
  private isAlreadyBust(game: GameState): boolean {
    const visit = game.currentVisit;
    if (!visit) return false;
    const handler = getModeHandler(game.settings.mode);
    if (!handler) return false;
    const remaining = handler.getRemainingScore(game, visit.playerId);
    const points = visit.darts.reduce((sum, d) => sum + d.score.points, 0);
    if (points > remaining) return true;
    return game.settings.doubleOut && remaining - points === 1;
  }
}
