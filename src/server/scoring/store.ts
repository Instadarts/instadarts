// Which scoring session belongs to which player of which match.
//
// Keyed by (matchId, ownerPlayerId), not by matchId alone. In an online match the two players stand
// at two different boards with two different cameras: one shared session would let one player's
// empty board submit the other's visit, and would repeat-filter one player's tips against the
// other's darts. A local match has one board and one frontend, so it has one session.
//
// Not keyed by the owning socket either — a frontend reload must not lose the record of which
// darts are already physically in the board, or they would all be counted a second time.

import type { MatchState } from '../../shared/types';
import { createHash } from 'crypto';
import { getMatch } from '../store';
import { ScoringSession } from './session';

const sessions = new Map<string, ScoringSession>();

/**
 * The stable identity of one board's scoring context.
 *
 * Also sent to scoring devices so they can tell a reconnect to this same context from a new match
 * without being given any of the match itself.
 */
function sessionKey(matchId: string, ownerPlayerId: string | null): string {
  return `${matchId}::${ownerPlayerId ?? ''}`;
}

/** Public identity of that key, without exposing either server-side identifier to the device. */
export function scoringContextId(matchId: string, ownerPlayerId: string | null): string {
  return createHash('sha256').update(sessionKey(matchId, ownerPlayerId)).digest('base64url');
}

/**
 * The session for this player of this match, created on first use.
 *
 * `commit` is supplied by the caller rather than imported, because persisting and broadcasting a
 * match is the transport layer's job and this module should not know how that is done.
 */
export function getScoringSession(
  matchId: string,
  ownerPlayerIds: string[] | null,
  commit: (match: MatchState) => void,
): ScoringSession {
  const primaryId = ownerPlayerIds?.[0] ?? null;
  const key = sessionKey(matchId, primaryId);
  let session = sessions.get(key);
  if (!session) {
    session = new ScoringSession({
      getMatch: () => getMatch(matchId) ?? null,
      ownerPlayerIds,
      commit,
    });
    sessions.set(key, session);
  }
  return session;
}

/** Drop every session watching a match — a ThrowWindows may be holding a live timer. */
export function dropScoringSessions(matchId: string): void {
  for (const [key, session] of sessions) {
    if (!key.startsWith(`${matchId}::`)) continue;
    session.stop();
    sessions.delete(key);
  }
}

/**
 * How many sessions are being held.
 *
 * Reported by /server-stats, because a session holds a live throw-window timer and a reference to
 * its match: if this number climbs while `runningMatches` does not, something is not letting go.
 */
export function scoringSessionCount(): number {
  return sessions.size;
}

/**
 * Collect sessions whose match is gone or over, and say how many there were.
 *
 * Nothing in the server calls this: every path that ends a match drops its sessions, and
 * `tests/unit/retention.test.ts` is what holds that true. It is kept as the assertion those tests
 * make — "and there was nothing left to collect" — which is a claim that needs a way to be checked.
 */
export function sweepScoringSessions(): number {
  let collected = 0;
  for (const [key, session] of sessions) {
    const matchId = key.slice(0, key.indexOf('::'));
    const match = getMatch(matchId);
    if (match && match.status === 'in_progress') continue;
    session.stop();
    sessions.delete(key);
    collected++;
  }
  return collected;
}

/** Test seam: forget everything, as a restart would. */
export function resetScoringSessions(): void {
  for (const session of sessions.values()) session.stop();
  sessions.clear();
}
