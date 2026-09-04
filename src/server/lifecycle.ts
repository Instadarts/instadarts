// When a lobby or a match dies.
//
// Every lobby and every match carries an `expiresAt`, and this is the only thing that reads it. The
// point is that there is no way to sit on the server forever: a match is either being actively
// played, or it is counting down to a definite end.
//
//   · **A lobby idle for 10 minutes is abandoned.** Everyone in it goes home.
//   · **A match idle for 10 minutes is cancelled** — finished, with no winner, exactly as if the
//     player had left. It then gets a summary like any other finished match.
//   · **A finished match is torn down 2 minutes later.** Unanswered re-match votes become declines
//     at that moment, and everyone still watching — players and spectators alike — goes home.
//
// The deadline lives on the state rather than in a timer per match, so it survives being copied
// around, is visible to the client (which counts it down), and needs no cleanup when a match ends
// some other way.

import type { Lobby, MatchState } from '../shared/types';
import { getAllLobbies, getAllMatches } from './store';

/** How long a lobby or an in-progress match may go without input. */
export const IDLE_TTL_MS = 10 * 60_000;
/** How long a finished match stays up for its summary and its re-match offer. */
export const SUMMARY_TTL_MS = 2 * 60_000;
/** How often the deadlines are checked. Fine enough that a countdown does not visibly overrun. */
const SWEEP_INTERVAL_MS = 5_000;

export interface LifecycleHandlers {
  /** An in-progress match went idle: cancel it, and give it its summary. */
  cancelIdleMatch(match: MatchState): void;
  /** A finished match reached its deadline: settle the vote and send everyone home. */
  closeMatch(match: MatchState): void;
  /** A lobby went idle: send everyone home. */
  expireLobby(lobby: Lobby): void;
}

let handlers: LifecycleHandlers | null = null;

/** Wired once by the transport layer, which is the only thing that can tell anybody anything. */
export function setLifecycleHandlers(next: LifecycleHandlers): void {
  handlers = next;
}

/** Push a deadline back. Called for anything that counts as input. */
export function touch(entity: { expiresAt: number }, ttlMs = IDLE_TTL_MS): void {
  entity.expiresAt = Date.now() + ttlMs;
}

/**
 * Act on everything that is due.
 *
 * `now` is a parameter so tests can stand at any point in the future without waiting for it.
 */
export function sweepLifecycle(now: number = Date.now()): void {
  if (!handlers) return;

  for (const match of [...getAllMatches().values()]) {
    if (now < match.expiresAt) continue;
    if (match.status === 'in_progress') handlers.cancelIdleMatch(match);
    else handlers.closeMatch(match);
  }

  for (const lobby of [...getAllLobbies().values()]) {
    if (now >= lobby.expiresAt) handlers.expireLobby(lobby);
  }
}

export function startLifecycle(): NodeJS.Timeout {
  return setInterval(() => sweepLifecycle(), SWEEP_INTERVAL_MS);
}
