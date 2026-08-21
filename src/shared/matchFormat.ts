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

/** One set: how its legs were shared, and who took it. */
export interface SetScore {
  /** Legs won in this set, by player id. */
  legWins: Record<string, number>;
  /** Who took the set, or null while it is still being played. */
  winnerId: string | null;
}

export interface Standings {
  /** Sets won, by player id. */
  setWins: Record<string, number>;
  /** Legs won **in the set being played**, by player id. Resets whenever a set is won. */
  legWins: Record<string, number>;
  /** How many sets have been decided. */
  setsPlayed: number;
  /** How many legs of the current set have been played. */
  legsInCurrentSet: number;
  /**
   * Every set that has been started, in order — the last may still be in progress. This is the
   * match's result read out set by set, the way a tennis scoreline is.
   */
  sets: SetScore[];
}

/** Where the match stands, from the legs played so far. */
export function standingsOf(legs: CompletedLeg[], settings: MatchSettings): Standings {
  const sets: SetScore[] = [];
  const setWins: Record<string, number> = {};
  let open: SetScore | null = null;

  for (const leg of legs) {
    if (!open) {
      open = { legWins: {}, winnerId: null };
      sets.push(open);
    }
    open.legWins[leg.winnerId] = (open.legWins[leg.winnerId] ?? 0) + 1;

    if (open.legWins[leg.winnerId] < settings.legsToWinSet) continue;

    // The set is won: it closes, and the next leg opens a new one.
    open.winnerId = leg.winnerId;
    setWins[leg.winnerId] = (setWins[leg.winnerId] ?? 0) + 1;
    open = null;
  }

  return {
    setWins,
    legWins: open ? { ...open.legWins } : {},
    setsPlayed: sets.length - (open ? 1 : 0),
    legsInCurrentSet: open ? Object.values(open.legWins).reduce((a, b) => a + b, 0) : 0,
    sets,
  };
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
 * The throw moves one place down the roster every leg and wraps at the end — with two players that
 * is the alternation darts expects, and with more of them it is a rota nobody sits out of. Each set
 * opens one place further along than the last did, whoever won it: sets open on the first player,
 * the second, the third and so on in turn. So a player who takes a set 3–1 — winning its last leg
 * — does not thereby throw first in the next one.
 */
export function starterIndex(standings: Standings, playerCount: number): number {
  if (playerCount <= 0) return 0;
  return (standings.setsPlayed + standings.legsInCurrentSet) % playerCount;
}
