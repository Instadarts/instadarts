// The game mode contract.
//
// A mode owns exactly one thing: how a **leg** is played and won. It does not know that matches,
// sets, legs, sockets, lobbies or spectators exist — everything it may look at is in LegContext,
// and everything it may decide comes back through the return values below.
//
// See docs/game-modes.md for the reasoning; the two rules that shape this file are:
//
//   · **A leg always ends with a winner.** `finalizeVisit` reports one, and match logic (first to n
//     legs, first to m sets) is built on that guarantee holding for every mode.
//   · **A mode holds no state.** Everything is derived from the visit history and the visit in
//     progress, which is what makes undo, reconnect and (later) a fresh leg free.

import type { CurrentVisit, ModeSettings, ModeView, Player, Visit } from '../../shared/types';

/**
 * One leg, as the mode sees it. Deliberately no match, no set, no leg number and no ids beyond the
 * players: a mode that cannot see the match structure cannot come to depend on it.
 */
export interface LegContext {
  /** This mode's own settings, already validated against its declared fields. */
  settings: ModeSettings;
  players: Player[];
  /** Whose visit it is. The match layer decides this; the mode only reads it. */
  currentPlayerId: string;
  /** Committed visits of this leg, in order. */
  visits: Visit[];
  currentVisit?: CurrentVisit;
}

export interface FinalizedVisit {
  /** The visit to append. The mode decides padding and whether it is void. */
  visit: Visit;
  /** Set iff this visit won the leg. */
  legWinnerId: string | null;
}

export interface GameMode {
  readonly id: string;

  /** How many darts a visit may hold. Read by the match layer and by the match screen. */
  dartsPerVisit(settings: ModeSettings): number;

  /**
   * May the visit in progress take another dart? Evaluated after each dart is appended, and again
   * after an undo.
   *
   * Locked is not ended: the visit stays open until it is submitted, which is the window in which a
   * misread dart gets corrected.
   */
  isVisitLocked(ctx: LegContext): boolean;

  /** Finalize the visit in progress into one to commit, and say whether it won the leg. */
  finalizeVisit(ctx: LegContext): FinalizedVisit;

  /**
   * Everything mode-specific the match screen shows. Computed here rather than in the browser so
   * that the client holds no rules and a new mode needs no client code.
   */
  view(ctx: LegContext): ModeView;
}

const modes = new Map<string, GameMode>();

export function registerMode(mode: GameMode): void {
  modes.set(mode.id, mode);
}

export function getMode(id: string): GameMode | undefined {
  return modes.get(id);
}
