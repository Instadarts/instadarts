import { describe, it, expect } from 'vitest';
import type { DartThrow, MatchState, ModeSettings, Visit } from '../../src/shared/types';
import { scoreFromBoardCoords } from '../../src/shared/scoring';
import { whacAMole, whacAreaOf, whacRun } from '../../src/server/modes/whac-a-mole';
import { addDartToMatch, legContext, submitVisitToMatch } from '../../src/server/match';
import { validateSettings } from '../../src/server/validation';
import { getMode } from '../../src/server/modes/types';

// Importing the mode is what registers it — the same act that installing it is.
import '../../src/server/modes/whac-a-mole';

// ============================================================
// Throwing at a named area
// ============================================================

const SECTOR_ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const MM = 0.5 / 225.5;

/** The middle of each ring, in millimetres from the centre — see the radii in shared/scoring.ts. */
const MID: Record<string, number> = {
  i: 56.5 * MM, T: 102 * MM, o: 133.5 * MM, D: 165 * MM, BULL: 0,
};

/** A dart in the middle of a named area, scored the way the server scores one. */
function dartAt(area: string): DartThrow {
  let r: number;
  let angle = 0;

  if (area === BURROW) {
    r = MID[area];
  } else {
    const ring = area[0];
    const number = ring === 'S' ? Number(area.slice(1, -1)) : Number(area.slice(1));
    r = MID[ring === 'S' ? (area.endsWith('i') ? 'i' : 'o') : ring];
    angle = (SECTOR_ORDER.indexOf(number) * 18 * Math.PI) / 180;
  }

  const x = Math.round((0.5 + r * Math.sin(angle)) * 1_000_000);
  const y = Math.round((0.5 + r * Math.cos(angle)) * 1_000_000);
  return { x, y, score: scoreFromBoardCoords(x, y) };
}

const MISS: DartThrow = { x: 2_000, y: 2_000, score: scoreFromBoardCoords(2_000, 2_000) };

/** The middle of the board: both bulls at once, and a hole before anybody throws. */
const BURROW = 'BULL';

const ALL_AREAS = [
  ...SECTOR_ORDER.flatMap((n) => [`S${n}o`, `S${n}i`, `T${n}`, `D${n}`]),
  BURROW,
];

// ============================================================
// A match to play it in
// ============================================================

const SETTINGS: ModeSettings = {
  rounds: 25, moles: 3, darts: 3, digTime: 3, difficulty: 'normal', seed: 4242,
};

function makeMatch(over: Partial<ModeSettings> = {}, players = 1): MatchState {
  return {
    id: 'test-match',
    status: 'in_progress',
    settings: {
      mode: 'whac-a-mole',
      modeSettings: { ...SETTINGS, ...over },
      legsToWinSet: 1,
      setsToWinMatch: 1,
    },
    players: [
      { id: 'p1', name: 'Alice' },
      { id: 'p2', name: 'Bob' },
    ].slice(0, players),
    visits: [],
    legs: [],
    currentPlayerIndex: 0,
    winnerId: null,
    createdAt: 0,
    finishedAt: null,
    isLocal: true,
    departed: [],
    rematchVotes: {},
    expiresAt: 0,
  };
}

/** The moles on the board as the player about to throw finds them. */
function molesOn(match: MatchState): string[] {
  return whacRun(legContext(match)).live.moles.map((m) => m.area);
}

function holesOn(match: MatchState): string[] {
  return whacRun(legContext(match)).live.holes;
}

/** The holes moles actually dug — the burrow was always there. */
function dugHoles(match: MatchState): string[] {
  return holesOn(match).filter((area) => area !== BURROW);
}

function runOf(match: MatchState) {
  return whacRun(legContext(match));
}

function throwAt(match: MatchState, area: string | DartThrow): MatchState {
  const playerId = match.players[match.currentPlayerIndex].id;
  const result = addDartToMatch(match, playerId, typeof area === 'string' ? dartAt(area) : area);
  if (!result.success) throw new Error(result.error);
  return result.match;
}

function submit(match: MatchState): MatchState {
  const result = submitVisitToMatch(match);
  if (!result.success) throw new Error(result.error);
  return result.match;
}

/** Throw a whole visit of misses and submit it. */
function idleVisit(match: MatchState): MatchState {
  let current = match;
  for (let i = 0; i < 3; i++) current = throwAt(current, MISS);
  return submit(current);
}

// ============================================================

describe('whac-a-mole: the board', () => {
  it('tells every one of the 81 areas apart, inner and outer singles included', () => {
    const wrong = ALL_AREAS.filter((area) => whacAreaOf(dartAt(area)) !== area);
    expect(wrong).toEqual([]);
    expect(ALL_AREAS).toHaveLength(81);
  });

  it('makes one area of the two bulls', () => {
    expect(dartAt(BURROW).score.label).toBe('DB');
    expect(whacAreaOf(dartAt(BURROW))).toBe(BURROW);
    // The outer bull is the same place as far as this mode is concerned.
    const outerBull = { x: 500_000, y: 500_000 + Math.round(11.25 * MM * 1_000_000) };
    expect(whacAreaOf({ ...outerBull, score: scoreFromBoardCoords(outerBull.x, outerBull.y) })).toBe(BURROW);
  });

  it('gives a dart off the board no area at all', () => {
    expect(whacAreaOf(MISS)).toBeNull();
  });

  it('reads an inner and an outer single of the same number as different places', () => {
    expect(dartAt('S18i').score.label).toBe('S18');
    expect(dartAt('S18o').score.label).toBe('S18');
    expect(whacAreaOf(dartAt('S18i'))).not.toBe(whacAreaOf(dartAt('S18o')));
  });
});

describe('whac-a-mole: the moles', () => {
  it('has a full set up at the start of every visit, never twice on one area', () => {
    let match = makeMatch();
    for (let visit = 0; visit < 8; visit++) {
      const moles = molesOn(match);
      expect(moles).toHaveLength(3);
      expect(new Set(moles).size).toBe(3);
      match = idleVisit(match);
    }
  });

  it('never comes up in a hole, and never in the burrow', () => {
    let match = makeMatch();
    for (let visit = 0; visit < 14; visit++) match = idleVisit(match);

    const holes = holesOn(match);
    expect(holes).toContain(BURROW);
    expect(dugHoles(match).length).toBeGreaterThan(0);
    expect(molesOn(match).some((area) => holes.includes(area))).toBe(false);
  });

  it('digs through when its dig time is up, and that area is a hole from then on', () => {
    let match = makeMatch({ digTime: 2 });
    const doomed = molesOn(match);

    match = idleVisit(match);
    expect(dugHoles(match)).toEqual([]);      // one visit of digging left
    match = idleVisit(match);

    expect(dugHoles(match)).toEqual(expect.arrayContaining(doomed));
  });

  it('leaves when it is whacked, and the area stays clean', () => {
    const match = makeMatch();
    const [first] = molesOn(match);
    const after = throwAt(match, first);

    expect(molesOn(after)).not.toContain(first);
    expect(dugHoles(after)).toEqual([]);
  });
});

describe('whac-a-mole: scoring', () => {
  const scoreOf = (match: MatchState, playerId = 'p1') => whacRun(legContext(match)).live.score[playerId];

  it('scores one per mole', () => {
    const match = makeMatch();
    const moles = molesOn(match);
    expect(scoreOf(match)).toBe(0);
    expect(scoreOf(throwAt(match, moles[0]))).toBe(1);
    expect(scoreOf(throwAt(throwAt(match, moles[0]), moles[1]))).toBe(2);
  });

  it('scores a bonus point for clearing three in one visit', () => {
    const match = makeMatch();
    const moles = molesOn(match);
    const full = moles.reduce((current, area) => throwAt(current, area), match);
    expect(scoreOf(full)).toBe(4);
  });

  it('scores nothing for a dart that lands in the wrong ring of the right number', () => {
    const match = makeMatch();
    const mole = molesOn(match).find((area) => area.startsWith('S') && area.endsWith('o'));
    if (!mole) return;

    const wrongRing = `T${mole.slice(1, -1)}`;
    expect(scoreOf(throwAt(match, wrongRing))).toBe(0);
    expect(molesOn(throwAt(match, wrongRing))).toContain(mole);
  });

  it('adds both players up into one team total', () => {
    let match = makeMatch({}, 2);
    match = submit(throwAt(match, molesOn(match)[0]));
    match = submit(throwAt(match, molesOn(match)[0]));

    const run = whacRun(legContext(match)).live;
    expect(run.score.p1).toBe(1);
    expect(run.score.p2).toBe(1);
  });
});

describe('whac-a-mole: holes and darts', () => {
  /** Play until there is a hole, and hand back the match and the hole. */
  function boardWithAHole(): { match: MatchState; hole: string } {
    let match = makeMatch({ digTime: 1 });
    match = idleVisit(match);
    return { match, hole: dugHoles(match)[0] };
  }

  it('costs a dart per visit, but only from the next visit', () => {
    const { match, hole } = boardWithAHole();

    // The visit the hole was hit in keeps every dart it started with.
    const during = throwAt(match, hole);
    expect(during.currentVisit?.locked).toBe(false);
    expect(whacAMole.isVisitLocked(legContext(throwAt(during, MISS)))).toBe(false);

    const next = submit(throwAt(during, MISS));
    expect(whacAMole.isVisitLocked(legContext(throwAt(throwAt(next, MISS), MISS)))).toBe(true);
  });

  it('locks a visit before a dart is thrown once a player has none left', () => {
    let { match, hole } = boardWithAHole();
    for (let i = 0; i < 3; i++) match = submit(throwAt(match, hole));

    expect(whacRun(legContext(match)).start.holesHit.p1).toBe(3);
    expect(whacAMole.isVisitLocked(legContext(match))).toBe(true);
  });

  it('ignores a dart thrown past the allowance rather than trusting the client', () => {
    const { match, hole } = boardWithAHole();
    const spent = submit(throwAt(match, hole));

    // Two darts is this player's lot; a third is forged and must not count for anything.
    const forged = {
      ...legContext(spent),
      currentVisit: { playerId: 'p1', darts: [dartAt(hole), MISS, MISS], locked: false },
    };
    expect(whacAMole.finalizeVisit(forged).visit.darts).toHaveLength(2);
  });
});

describe('whac-a-mole: how a run ends', () => {
  it('plays exactly as many rounds as it says, then hands the leg a winner', () => {
    let match = makeMatch({ rounds: 5 });
    for (let round = 0; round < 5; round++) {
      expect(whacAMole.finalizeVisit(legContext(match)).legWinnerId).toBeNull();
      match = idleVisit(match);
    }

    expect(whacAMole.isVisitLocked(legContext(match))).toBe(true);
    expect(whacAMole.finalizeVisit(legContext(match)).legWinnerId).toBe('p1');
    expect(submit(match).status).toBe('finished');
  });

  it('ends the moment nobody has a dart left', () => {
    let match = makeMatch({ digTime: 1, rounds: 50 });
    match = idleVisit(match);
    // A hole a mole dug, not the burrow — the janitor is only ever in the middle, and this is about
    // running out of darts rather than about getting one back.
    const hole = dugHoles(match)[0];

    for (let i = 0; i < 3; i++) match = submit(throwAt(match, hole));

    expect(whacAMole.finalizeVisit(legContext(match)).legWinnerId).toBe('p1');
  });

  it('names the better of two players, and only ever one', () => {
    let match = makeMatch({ rounds: 2 }, 2);
    match = submit(throwAt(match, molesOn(match)[0]));   // Alice whacks one
    match = idleVisit(match);                            // Bob does not
    match = idleVisit(match);
    match = idleVisit(match);

    const finished = submit(match);
    expect(finished.status).toBe('finished');
    expect(finished.winnerId).toBe('p1');
  });
});

describe('whac-a-mole: the burrow and its janitor', () => {
  it('is a hole before anybody throws, and costs a dart like any other', () => {
    const match = makeMatch();
    expect(holesOn(match)).toEqual([BURROW]);
    expect(dugHoles(match)).toEqual([]);

    const after = submit(throwAt(match, BURROW));
    expect(runOf(after).start.holesHit.p1).toBe(1);
    expect(runOf(after).start.lost).toEqual(['p1']);
  });

  /**
   * Lose a dart down the burrow, then play on until the janitor is up — optionally until it is up
   * on a visit that also satisfies `want`. Its odds are even per visit, so this is a handful of
   * visits, and the seed makes it the same handful every run.
   */
  function untilJanitor(match: MatchState, want?: (m: MatchState) => boolean): MatchState {
    let current = submit(throwAt(match, BURROW));
    for (let i = 0; i < 40; i++) {
      if (runOf(current).live.janitor && (!want || want(current))) return current;
      current = idleVisit(current);
    }
    throw new Error('the janitor never came');
  }

  it('never comes up when there is nothing down there to hold', () => {
    let match = makeMatch();
    for (let visit = 0; visit < 10; visit++) {
      expect(runOf(match).live.janitor).toBe(false);
      match = idleVisit(match);
    }
  });

  it('hands the dart back to whoever lost it, and scores the player who hit it', () => {
    const match = untilJanitor(makeMatch({}, 2));
    const holder = runOf(match).live.lost[0];
    const thrower = match.players[match.currentPlayerIndex].id;

    const after = throwAt(match, BURROW);
    const run = runOf(after).live;

    expect(run.janitor).toBe(false);
    expect(run.lost).toEqual([]);
    expect(run.holesHit[holder]).toBe(0);
    expect(run.rescued[thrower]).toBe(1);
    expect(run.score[thrower]).toBe(1);
  });

  it('lets one player get a dart back for the other', () => {
    // Alice loses one; we wait for a visit where the janitor is up and Bob is the one throwing.
    const match = untilJanitor(
      makeMatch({}, 2),
      (m) => m.players[m.currentPlayerIndex].id !== runOf(m).live.lost[0],
    );

    const rescuer = match.players[match.currentPlayerIndex].id;
    const owner = runOf(match).live.lost[0];
    expect(rescuer).not.toBe(owner);

    const after = runOf(throwAt(match, BURROW)).live;
    expect(after.holesHit[owner]).toBe(0);
    expect(after.rescued[rescuer]).toBe(1);
  });

  it('hands back one dart a visit — the second is the hole again', () => {
    const match = untilJanitor(makeMatch({ darts: 3 }, 2));
    const thrower = match.players[match.currentPlayerIndex].id;

    const rescued = throwAt(match, BURROW);
    expect(runOf(rescued).live.lost).toEqual([]);

    const greedy = throwAt(rescued, BURROW);
    const run = runOf(greedy).live;
    expect(run.rescued[thrower]).toBe(1);
    expect(run.lost).toEqual([thrower]);
    expect(run.holesHit[thrower]).toBe(1);
  });

  it('goes home at the end of the visit whether or not it was hit', () => {
    const match = untilJanitor(makeMatch());
    expect(runOf(match).live.janitor).toBe(true);
    // Its being there next visit is next visit's roll, not this one's.
    expect(runOf(idleVisit(match)).start.janitor).toBe(false);
  });
});

describe('whac-a-mole: the same run for everybody', () => {
  it('draws the same board from the same visits, however often it is asked', () => {
    let match = makeMatch();
    for (let i = 0; i < 6; i++) match = idleVisit(match);

    const once = whacRun(legContext(match)).live;
    const twice = whacRun(legContext(match)).live;
    expect(twice.moles).toEqual(once.moles);
    expect(twice.holes).toEqual(once.holes);
    expect(whacAMole.view(legContext(match))).toEqual(whacAMole.view(legContext(match)));
  });

  it('gives a different colony to a different seed', () => {
    const a = molesOn(makeMatch({ seed: 1 }));
    const b = molesOn(makeMatch({ seed: 2 }));
    expect(a).not.toEqual(b);
  });

  it('takes the seed and nothing else — not who is playing, and not who threw first', () => {
    const solo = makeMatch({ seed: 99 }, 1);
    const pair = makeMatch({ seed: 99 }, 2);
    expect(molesOn(pair)).toEqual(molesOn(solo));

    // The same seed with the players the other way round is the same colony too.
    const swapped: MatchState = { ...pair, players: [...pair.players].reverse(), currentPlayerIndex: 0 };
    expect(molesOn(swapped)).toEqual(molesOn(pair));
  });

  it('draws the same faces and the same taunts for one seed', () => {
    const custom = (m: MatchState) => whacAMole.panel!(m)!.custom as {
      moles: { variant: number; label: string }[];
    };
    const a = custom(makeMatch({ seed: 7 }));
    const b = custom(makeMatch({ seed: 7 }));
    const other = custom(makeMatch({ seed: 8 }));

    expect(b.moles.map((m) => [m.label, m.variant])).toEqual(a.moles.map((m) => [m.label, m.variant]));
    expect(other.moles.map((m) => m.label)).not.toEqual(a.moles.map((m) => m.label));
  });

  it('diverges from where the darts actually landed, not just from the seed', () => {
    const match = makeMatch();
    const moles = molesOn(match);

    const hitLow = submit(throwAt(match, moles[0]));
    const hitHigh = submit(throwAt(match, moles[1]));
    expect(molesOn(hitLow)).not.toEqual(molesOn(hitHigh));
  });

  it('is unaffected by a visit being replayed dart by dart', () => {
    const match = makeMatch();
    const before = molesOn(match);
    expect(molesOn(throwAt(match, MISS))).toEqual(before);
  });
});

describe('whac-a-mole: settings', () => {
  it('draws a fresh seed for every lobby that picks it, and nothing else moves', () => {
    const first = whacAMole.defaults;
    const second = whacAMole.defaults;

    expect(first.seed).not.toBe(second.seed);
    expect({ ...first, seed: 0 }).toEqual({ ...second, seed: 0 });
    expect(first).toMatchObject({ rounds: 25, moles: 3, darts: 3, digTime: 3, difficulty: 'normal' });
  });

  it('keeps the seed out of the lobby, so nothing can choose it', () => {
    expect(whacAMole.fields.map((f) => f.key)).toEqual(['rounds', 'moles', 'darts', 'digTime', 'difficulty']);

    const current = { mode: 'whac-a-mole', modeSettings: { ...SETTINGS }, legsToWinSet: 1, setsToWinMatch: 1 };
    const validated = validateSettings(
      { mode: 'whac-a-mole', modeSettings: { seed: 7, rounds: 10 } },
      current,
    );

    expect(validated?.modeSettings.seed).toBe(SETTINGS.seed);
    expect(validated?.modeSettings.rounds).toBe(10);
  });

  it('is installed, and offers itself to the lobby', () => {
    expect(getMode('whac-a-mole')).toBe(whacAMole);
    expect(whacAMole.label).toBe('Whac-A-Mole');
    expect(whacAMole.dartsPerVisit({ ...SETTINGS, darts: 4 })).toBe(4);
  });
});

describe('whac-a-mole: what the screen is told', () => {
  it('draws a full row of slots, with the darts lost to holes shown as lost', () => {
    let match = makeMatch({ digTime: 1 });
    match = idleVisit(match);
    match = submit(throwAt(match, holesOn(match)[0]));

    const slots = whacAMole.view(legContext(match)).slots ?? [];
    expect(slots).toHaveLength(3);
    expect(slots.filter((slot) => typeof slot !== 'string' && slot.text === '✖ lost')).toHaveLength(1);
  });

  it('hands its own component a snapshot, and everyone else a table', () => {
    const match = makeMatch();
    const panel = whacAMole.panel!(match)!;

    expect(panel.rows.map((row) => row.label)).toEqual(['Score', 'Darts left', 'Holes hit']);
    expect(panel.rows[1].values.p1).toBe('3');

    const custom = panel.custom as { phase: string; moles: { label: string }[]; round: number };
    expect(custom.phase).toBe('playing');
    expect(custom.round).toBe(1);
    expect(custom.moles).toHaveLength(3);
    expect(JSON.parse(JSON.stringify(panel))).toEqual(panel);   // it has to survive the wire
  });

  it('describes the finished run rather than the empty leg left behind it', () => {
    let match = makeMatch({ rounds: 1 });
    match = submit(throwAt(match, molesOn(match)[0]));
    expect(match.status).toBe('in_progress');
    match = submit(match);

    expect(match.status).toBe('finished');
    const custom = whacAMole.panel!(match)!.custom as { team: number; phase: string };
    expect(custom.team).toBe(1);
    expect(custom.phase).toBe('finale');
  });
});
