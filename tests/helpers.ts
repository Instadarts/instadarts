import type { GameState, ScoreResult } from '../src/shared/types';

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

/** Create a GameState with sensible defaults for testing. */
export function makeGame(overrides: Partial<GameState> = {}): GameState {
  const { settings: settingsOverride, ...rest } = overrides;
  return {
    id: 'test-game',
    status: 'in_progress',
    settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 501, ...settingsOverride },
    players: [
      { id: 'p1', name: 'Alice', isRemote: false, sessionId: 's1' },
      { id: 'p2', name: 'Bob', isRemote: false, sessionId: 's2' },
    ],
    visits: [],
    currentPlayerIndex: 0,
    winnerId: null,
    createdAt: 0,
    finishedAt: null,
    isLocal: false,
    ...rest,
  };
}
