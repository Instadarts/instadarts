import type { MatchState, ScoreResult, Visit } from '../src/shared/types';
import { registerMode } from '../src/server/modes/types';
import { x01 } from '../src/server/modes/x01';
import { addDartToMatch, legContext, submitVisitToMatch, undoDartFromMatch } from '../src/server/match';
import { IDLE_TTL_MS } from '../src/server/lifecycle';

// Every test that touches a match needs the mode registered; importing these helpers is what does it.
registerMode(x01);

/** Create a dart object from a label (e.g. "T20", "D16", "miss"). */
export function makeDart(label: string, x = 500_000, y = 500_000) {
  const darts: Record<string, ScoreResult> = {
    'T20': { label: 'T20', points: 60, mult: 3, base: 20 },
    'T19': { label: 'T19', points: 57, mult: 3, base: 19 },
    'T18': { label: 'T18', points: 54, mult: 3, base: 18 },
    'T17': { label: 'T17', points: 51, mult: 3, base: 17 },
    'S20': { label: 'S20', points: 20, mult: 1, base: 20 },
    'S19': { label: 'S19', points: 19, mult: 1, base: 19 },
    'S18': { label: 'S18', points: 18, mult: 1, base: 18 },
    'S5':  { label: 'S5',  points: 5,  mult: 1, base: 5 },
    'S1':  { label: 'S1',  points: 1,  mult: 1, base: 1 },
    'D20': { label: 'D20', points: 40, mult: 2, base: 20 },
    'D16': { label: 'D16', points: 32, mult: 2, base: 16 },
    'D10': { label: 'D10', points: 20, mult: 2, base: 10 },
    'D8':  { label: 'D8',  points: 16, mult: 2, base: 8 },
    'D4':  { label: 'D4',  points: 8,  mult: 2, base: 4 },
    'DB':  { label: 'DB',  points: 50, mult: 2, base: 25 },
    'SB':  { label: 'SB',  points: 25, mult: 1, base: 25 },
    'miss':{ label: 'miss',points: 0,  mult: 0, base: 0 },
  };
  const score = darts[label];
  if (!score) throw new Error(`Unknown dart label: ${label}`);
  return { x, y, score };
}

/** x01's settings and the match format, flat, as tests find it natural to write them. */
export interface X01Over {
  mode?: string;
  startScore?: number;
  doubleIn?: boolean;
  doubleOut?: boolean;
  stats?: 'graphic' | 'text' | 'off';
  legsToWinSet?: number;
  setsToWinMatch?: number;
}

type MatchOver = Partial<Omit<MatchState, 'settings'>> & { settings?: X01Over };

/** Create a MatchState with sensible defaults for testing. */
export function makeMatch(overrides: MatchOver = {}): MatchState {
  const { settings: over = {}, ...rest } = overrides;
  const { mode = 'x01', legsToWinSet = 1, setsToWinMatch = 1, ...modeSettings } = over;
  return {
    id: 'test-match',
    status: 'in_progress',
    settings: {
      mode,
      modeSettings: { startScore: 501, doubleIn: false, doubleOut: true, ...modeSettings },
      legsToWinSet,
      setsToWinMatch,
    },
    players: [
      { id: 'p1', name: 'Alice', sessionId: 's1' },
      { id: 'p2', name: 'Bob', sessionId: 's2' },
    ],
    visits: [],
    legs: [],
    currentPlayerIndex: 0,
    winnerId: null,
    createdAt: 0,
    finishedAt: null,
    departed: [],
    rematchVotes: {},
    // What `touch()` gives a real match. Zero is in the past, so anything that swept this one would
    // find it already expired.
    expiresAt: Date.now() + IDLE_TTL_MS,
    ...rest,
  };
}

/**
 * The current leg as the mode sees it — for testing a mode directly. The real one, deliberately: a
 * second copy of it here is exactly the kind of drift these tests exist to catch.
 */
export const legOf = legContext;

/** Throw one dart through the match layer. Throws if the match layer refused it. */
export function throwDart(match: MatchState, playerId: string, label: string): { match: MatchState; locked: boolean } {
  const result = addDartToMatch(match, playerId, makeDart(label));
  if (!result.success) throw new Error(result.error);
  return { match: result.match, locked: result.locked };
}

/** Take back the last dart through the match layer. */
export function undoDart(match: MatchState): MatchState {
  const result = undoDartFromMatch(match);
  if (!result.success) throw new Error(result.error);
  return result.match;
}

/** Submit the visit in progress through the match layer. */
export function submitVisit(match: MatchState): MatchState {
  const result = submitVisitToMatch(match);
  if (!result.success) throw new Error(result.error);
  return result.match;
}

/**
 * Every committed visit, finished legs first.
 *
 * A visit that wins a leg closes that leg and moves into `match.legs`, so a test about the rules of
 * a visit should ask for the visits rather than for one particular place they might be.
 */
export function visitsOf(match: MatchState): Visit[] {
  return [...match.legs.flatMap((leg) => leg.visits), ...match.visits];
}

/** Throw a whole visit and submit it. */
export function playVisit(match: MatchState, playerId: string, labels: string[]): MatchState {
  let current = match;
  for (const label of labels) current = throwDart(current, playerId, label).match;
  return submitVisit(current);
}
