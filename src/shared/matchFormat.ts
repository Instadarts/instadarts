// The shape of a match: how many legs win a set, how many sets win the match, and what the leg
// results so far add up to.
//
// **Standings are derived, never stored.** The ordered list of leg winners is the only truth; set
// wins, the leg count within the current set and whether the match is over all fall out of replaying
// it. That is the same discipline that makes a game mode stateless — and it is what makes a fresh
// leg, and a re-match, free.
//
// Shared because the server decides with it and the client displays with it. One implementation, and
// nothing derived travels on the wire.

import type { CompletedLeg, MatchSettings } from './types';
import type { SettingsField } from './settings';

/** Match-level settings, declared exactly as a mode declares its own. */
export const MATCH_FIELDS: SettingsField[] = [
  { key: 'setsToWinMatch', label: 'Sets to win the match', kind: 'number', min: 1, max: 21 },
  { key: 'legsToWinSet', label: 'Legs to win a set', kind: 'number', min: 1, max: 21 },
];

/** One set, one leg: a single play-through, which is what a match was before sets and legs existed. */
export const DEFAULT_FORMAT = { setsToWinMatch: 1, legsToWinSet: 1 };

export interface Standings {
  /** Sets won, by player id. */
  setWins: Record<string, number>;
  /** Legs won **in the set being played**, by player id. Resets whenever a set is won. */
  legWins: Record<string, number>;
  /** How many sets have been decided. */
  setsPlayed: number;
  /** How many legs of the current set have been played. */
  legsInCurrentSet: number;
}

/** Where the match stands, from the legs played so far. */
export function standingsOf(legs: CompletedLeg[], settings: MatchSettings): Standings {
  const setWins: Record<string, number> = {};
  let legWins: Record<string, number> = {};
  let setsPlayed = 0;
  let legsInCurrentSet = 0;

  for (const leg of legs) {
    legWins[leg.winnerId] = (legWins[leg.winnerId] ?? 0) + 1;
    legsInCurrentSet += 1;

    if (legWins[leg.winnerId] < settings.legsToWinSet) continue;

    // The set is won: it closes, and the leg tally starts again.
    setWins[leg.winnerId] = (setWins[leg.winnerId] ?? 0) + 1;
    setsPlayed += 1;
    legWins = {};
    legsInCurrentSet = 0;
  }

  return { setWins, legWins, setsPlayed, legsInCurrentSet };
}

/** Who has won the match, or null while it is still on. */
export function matchWinnerOf(standings: Standings, settings: MatchSettings): string | null {
  for (const [playerId, wins] of Object.entries(standings.setWins)) {
    if (wins >= settings.setsToWinMatch) return playerId;
  }
  return null;
}

/**
 * Who throws first in the leg about to start.
 *
 * The throw alternates every leg, and every set alternates independently of how the last one ended:
 * the first player starts sets 1, 3, 5 and the second starts sets 2, 4, 6, whoever won what. So a
 * player who takes a set 3–1 — winning its last leg — still throws first in the next set.
 */
export function starterIndex(standings: Standings, playerCount: number): number {
  if (playerCount <= 0) return 0;
  return (standings.setsPlayed + standings.legsInCurrentSet) % playerCount;
}
