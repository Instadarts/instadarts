import { getAllMatches, deleteMatch, getAllLobbies, deleteLobby } from './store';
import { sweepScoringSessions } from './scoring/store';

const GC_INTERVAL_MS = 30_000;
/**
 * A backstop, not the main event. Finished matches are torn down by the lifecycle sweep when their
 * summary runs out; this reclaims anything that somehow outlived that.
 */
const FINISHED_MATCH_TTL_MS = 5 * 60 * 1000;

let lobbiesCollected = 0;
let matchesCollected = 0;
let scoringSessionsCollected = 0;
let lastRunAt: number | null = null;
let lastDurationMs = 0;

export function getGCStats() {
  return {
    lobbiesCollected,
    matchesCollected,
    scoringSessionsCollected,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    lastDurationMs,
  };
}

export function startGC(): NodeJS.Timeout {
  return setInterval(() => {
    const start = Date.now();
    const now = start;

    for (const [id, match] of getAllMatches()) {
      if (match.status === 'finished' && match.finishedAt) {
        if (now - match.finishedAt > FINISHED_MATCH_TTL_MS) {
          deleteMatch(id);
          matchesCollected++;
        }
      }
    }

    // Lobbies are abandoned by the lifecycle sweep, which tells the people in them. Anything still
    // here well past its deadline had nobody to tell.
    for (const [id, lobby] of getAllLobbies()) {
      if (now > lobby.expiresAt + FINISHED_MATCH_TTL_MS) {
        deleteLobby(id);
        lobbiesCollected++;
      }
    }

    // Scoring sessions hold a live throw-window timer, and an abandoned in-progress match is never
    // collected above — so they are swept on their own terms rather than with the match.
    scoringSessionsCollected += sweepScoringSessions();

    lastRunAt = now;
    lastDurationMs = Date.now() - start;
  }, GC_INTERVAL_MS);
}
