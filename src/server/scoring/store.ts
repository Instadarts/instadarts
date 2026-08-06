// Which scoring session belongs to which player of which match.
//
// Keyed by (gameId, ownerPlayerId), not by gameId alone. In an online match the two players stand
// at two different boards with two different cameras: one shared session would let one player's
// empty board submit the other's visit, and would repeat-filter one player's tips against the
// other's darts. A local match has one board and one frontend, so it has one session.
//
// Not keyed by the owning socket either — a frontend reload must not lose the record of which
// darts are already physically in the board, or they would all be counted a second time.

import type { GameState } from '../../shared/types';
import { getGame } from '../store';
import { ScoringSession } from './session';

const sessions = new Map<string, ScoringSession>();

function sessionKey(gameId: string, ownerPlayerId: string | null): string {
  return `${gameId}::${ownerPlayerId ?? ''}`;
}

/**
 * The session for this player of this match, created on first use.
 *
 * `commit` is supplied by the caller rather than imported, because persisting and broadcasting a
 * game is the transport layer's job and this module should not know how that is done.
 */
export function getScoringSession(
  gameId: string,
  ownerPlayerId: string | null,
  commit: (game: GameState) => void,
): ScoringSession {
  const key = sessionKey(gameId, ownerPlayerId);
  let session = sessions.get(key);
  if (!session) {
    session = new ScoringSession({
      getGame: () => getGame(gameId) ?? null,
      ownerPlayerId,
      commit,
    });
    sessions.set(key, session);
  }
  return session;
}

/** Drop every session watching a game — a ThrowWindows may be holding a live timer. */
export function dropScoringSessions(gameId: string): void {
  for (const [key, session] of sessions) {
    if (!key.startsWith(`${gameId}::`)) continue;
    session.stop();
    sessions.delete(key);
  }
}

/** Collect sessions whose match is gone or over. Called by the garbage collector. */
export function sweepScoringSessions(): number {
  let collected = 0;
  for (const [key, session] of sessions) {
    const gameId = key.slice(0, key.indexOf('::'));
    const game = getGame(gameId);
    if (game && game.status === 'in_progress') continue;
    session.stop();
    sessions.delete(key);
    collected++;
  }
  return collected;
}

export function scoringSessionCount(): number {
  return sessions.size;
}

/** Test seam: forget everything, as a restart would. */
export function resetScoringSessions(): void {
  for (const session of sessions.values()) session.stop();
  sessions.clear();
}
