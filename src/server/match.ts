// The match layer: everything about a match that is not a rule of the game mode.
//
// It owns the structure (today one leg per match; sets and legs slot in at the one marked place
// below), whose visit it is, and the lifecycle. It holds a dart in the current visit and asks the
// mode what that means — it never interprets one itself.

import type { DartThrow, MatchState, ModeView } from '../shared/types';
import { getMode } from './modes/types';
import type { GameMode, LegContext } from './modes/types';

type Failure = { success: false; error: string };

function activeMode(match: MatchState): GameMode | Failure {
  if (match.status !== 'in_progress') return { success: false, error: 'Match is not in progress' };
  const mode = getMode(match.settings.mode);
  if (!mode) return { success: false, error: `Unknown game mode: ${match.settings.mode}` };
  return mode;
}

function isFailure(value: GameMode | Failure): value is Failure {
  return 'success' in value;
}

/** The current leg, as the mode sees it. Today a match is exactly one leg. */
export function legContext(match: MatchState): LegContext {
  return {
    settings: match.settings.modeSettings,
    players: match.players,
    currentPlayerId: match.currentVisit?.playerId ?? match.players[match.currentPlayerIndex].id,
    visits: match.visits,
    currentVisit: match.currentVisit,
  };
}

/** Whether the visit in progress is locked, per the mode. */
function lockedNow(mode: GameMode, match: MatchState): boolean {
  return mode.isVisitLocked(legContext(match));
}

export function addDartToMatch(
  match: MatchState,
  playerId: string,
  dart: DartThrow,
): { success: true; match: MatchState; locked: boolean } | Failure {
  const mode = activeMode(match);
  if (isFailure(mode)) return mode;

  const currentPlayer = match.players[match.currentPlayerIndex];
  if (playerId !== currentPlayer.id) return { success: false, error: 'Not your turn' };

  const cv = match.currentVisit ?? { playerId, darts: [], locked: false };
  // A locked visit takes no further dart. Saying so is not an error: the camera keeps the dart
  // tracked, and a person simply cannot click the board.
  if (cv.locked || cv.darts.length >= mode.dartsPerVisit(match.settings.modeSettings)) {
    return { success: true, match, locked: true };
  }

  const next: MatchState = { ...match, currentVisit: { playerId, darts: [...cv.darts, dart], locked: false } };
  const locked = lockedNow(mode, next);
  next.currentVisit = { ...next.currentVisit!, locked };
  return { success: true, match: next, locked };
}

/** Remove the last dart of the visit in progress (LIFO). Universal — the mode only re-judges the result. */
export function undoDartFromMatch(
  match: MatchState,
): { success: true; match: MatchState } | Failure {
  const mode = activeMode(match);
  if (isFailure(mode)) return mode;

  const cv = match.currentVisit;
  if (!cv || cv.darts.length <= 1) return { success: true, match: { ...match, currentVisit: undefined } };

  const next: MatchState = { ...match, currentVisit: { ...cv, darts: cv.darts.slice(0, -1), locked: false } };
  next.currentVisit = { ...next.currentVisit!, locked: lockedNow(mode, next) };
  return { success: true, match: next };
}

/**
 * Submit the visit in progress.
 *
 * The mode finalizes it and says whether it won the leg; everything after that — passing the board
 * to the other player, and what a won leg means for the match — is this layer's.
 */
export function submitVisitToMatch(
  match: MatchState,
): { success: true; match: MatchState } | Failure {
  const mode = activeMode(match);
  if (isFailure(mode)) return mode;

  const { visit, legWinnerId } = mode.finalizeVisit(legContext(match));

  const next: MatchState = {
    ...match,
    visits: [...match.visits, visit],
    currentVisit: undefined,
  };

  if (legWinnerId === null) {
    // A submitted visit always passes the board on. That a visit is exactly one player's turn is a
    // property of the app, not of any mode.
    next.currentPlayerIndex = (match.currentPlayerIndex + 1) % match.players.length;
    return { success: true, match: next };
  }

  // The leg is won. Sets and legs go here: today a match is one leg, so winning it wins the match.
  next.status = 'finished';
  next.winnerId = legWinnerId;
  next.finishedAt = Date.now();
  return { success: true, match: next };
}

/**
 * What the game mode says to show for this match.
 *
 * Travels with every match message. An unknown mode still has to render something, so it gets an
 * empty view rather than an exception on the broadcast path.
 */
export function viewOf(match: MatchState): ModeView {
  const mode = getMode(match.settings.mode);
  if (!mode) return { headline: '', playerScores: {}, visitTotal: '', dartsPerVisit: 0, history: [] };
  return mode.view(legContext(match));
}
