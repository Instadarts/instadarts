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
  turns: 25, moles: 3, darts: 3, digTime: 3, difficulty: 'medium', seed: 4242,
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
    players: Array.from({ length: players }, (_, i) => ({
      id: `p${i + 1}`,
      name: ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'][i] ?? `P${i + 1}`,
    })),
    visits: [],
    legs: [],
    currentPlayerIndex: 0,
    winnerId: null,
    createdAt: 0,
    finishedAt: null,
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

/**
 * Idle until the run says it is over, and report how many visits that took.
 *
 * A miss costs nothing, so the only thing that can end one of these is the turn limit — which is
 * what makes the count the run's length rather than a story about darts.
 */
function playOut(match: MatchState): { match: MatchState; visits: number } {
  let current = match;
  for (let visits = 0; visits <= 200; visits++) {
    if (whacAMole.finalizeVisit(legContext(current)).legWinnerId !== null) return { match: current, visits };
    current = idleVisit(current);
  }
  throw new Error('the run never ended');
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

  it('scores a bonus point for clearing the board in one visit', () => {
    const match = makeMatch();
    const moles = molesOn(match);
    const full = moles.reduce((current, area) => throwAt(current, area), match);
    expect(scoreOf(full)).toBe(4);
  });

  it('asks for the whole board, or every dart, whichever runs out first', () => {
    // Two moles and three darts: the sweep is two, not the three it used to be hardcoded at.
    const pair = makeMatch({ moles: 2 });
    const cleared = molesOn(pair).reduce((current, area) => throwAt(current, area), pair);
    expect(molesOn(cleared)).toEqual([]);
    expect(scoreOf(cleared)).toBe(3);

    // Five moles and three darts: three is every dart in hand, so it pays.
    const many = makeMatch({ moles: 5 });
    const spent = molesOn(many).slice(0, 3).reduce((current, area) => throwAt(current, area), many);
    expect(scoreOf(spent)).toBe(4);
    expect(molesOn(spent)).toHaveLength(2);
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
  it('plays exactly as many turns as it says, then hands the leg a winner', () => {
    let match = makeMatch({ turns: 5 });
    for (let turn = 0; turn < 5; turn++) {
      expect(whacAMole.finalizeVisit(legContext(match)).legWinnerId).toBeNull();
      match = idleVisit(match);
    }

    expect(whacAMole.isVisitLocked(legContext(match))).toBe(true);
    expect(whacAMole.finalizeVisit(legContext(match)).legWinnerId).toBe('p1');
    expect(submit(match).status).toBe('finished');
  });

  it('ends the moment nobody has a dart left', () => {
    let match = makeMatch({ digTime: 1, turns: 50 });
    match = idleVisit(match);
    // A hole a mole dug, not the burrow — the janitor is only ever in the middle, and this is about
    // running out of darts rather than about getting one back.
    const hole = dugHoles(match)[0];

    for (let i = 0; i < 3; i++) match = submit(throwAt(match, hole));

    expect(whacAMole.finalizeVisit(legContext(match)).legWinnerId).toBe('p1');
  });

  it('names the better of two players, and only ever one', () => {
    // Four turns, shared by two — which is what the two rounds this used to ask for came to.
    let match = makeMatch({ turns: 4 }, 2);
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

  it('hands the dart back to whoever lost it, and scores nobody for it', () => {
    const match = untilJanitor(makeMatch({}, 2));
    const holder = runOf(match).live.lost[0];
    const thrower = match.players[match.currentPlayerIndex].id;

    const after = throwAt(match, BURROW);
    const run = runOf(after).live;

    expect(run.janitor).toBe(false);
    expect(run.lost).toEqual([]);
    expect(run.holesHit[holder]).toBe(0);
    expect(run.rescued[thrower]).toBe(1);
    // The janitor pays in darts, not points — three moles a turn plus the sweep is the ceiling.
    expect(run.score[thrower]).toBe(0);
    expect(run.whacks[thrower]).toBe(0);
  });

  it('pays a bonus throw, this visit, on top of the dart going home', () => {
    const match = untilJanitor(makeMatch({}, 2));
    const thrower = match.players[match.currentPlayerIndex].id;
    expect(whacAMole.isVisitLocked(legContext(match))).toBe(false);

    // Three of their own and then the one the janitor gave back.
    let current = throwAt(match, BURROW);
    for (let i = 0; i < 2; i++) current = throwAt(current, MISS);
    expect(current.currentVisit?.darts).toHaveLength(SETTINGS.darts as number);
    expect(whacAMole.isVisitLocked(legContext(current))).toBe(false);

    const mole = molesOn(current)[0];
    current = throwAt(current, mole);
    expect(current.currentVisit?.darts).toHaveLength((SETTINGS.darts as number) + 1);
    expect(whacAMole.isVisitLocked(legContext(current))).toBe(true);

    // And the extra dart counted for something.
    expect(runOf(current).live.score[thrower]).toBe(1);
    expect(whacAMole.finalizeVisit(legContext(current)).visit.darts)
      .toHaveLength((SETTINGS.darts as number) + 1);
  });

  it('pays it once, and only to a visit that earned it', () => {
    const match = makeMatch({}, 2);
    const three = [MISS, MISS, MISS].reduce((m) => throwAt(m, MISS), match);
    expect(three.currentVisit?.darts).toHaveLength(3);
    expect(whacAMole.isVisitLocked(legContext(three))).toBe(true);

    // A dart forced past the lock is still worth nothing.
    const forged = {
      ...legContext(three),
      currentVisit: { playerId: three.players[0].id, darts: [...three.currentVisit!.darts, MISS], locked: false },
    };
    expect(whacAMole.finalizeVisit(forged).visit.darts).toHaveLength(3);
  });

  it('keeps a clean sweep worth four, whether or not the janitor was in', () => {
    const match = untilJanitor(makeMatch({}, 2));
    const thrower = match.players[match.currentPlayerIndex].id;

    let current = throwAt(match, BURROW);
    for (const area of molesOn(current)) current = throwAt(current, area);

    const run = runOf(current).live;
    expect(current.currentVisit?.darts).toHaveLength((SETTINGS.darts as number) + 1);
    expect(run.whacks[thrower]).toBe(3);
    expect(run.score[thrower]).toBe(4);      // three moles and the sweep, nothing for the janitor
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
    expect(first).toMatchObject({ turns: 50, moles: 3, darts: 3, digTime: 3, difficulty: 'medium' });
  });

  it('keeps the seed out of the lobby, so nothing can choose it', () => {
    expect(whacAMole.fields.map((f) => f.key)).toEqual(['turns', 'moles', 'darts', 'digTime', 'difficulty']);

    const current = { mode: 'whac-a-mole', modeSettings: { ...SETTINGS }, legsToWinSet: 1, setsToWinMatch: 1 };
    const validated = validateSettings(
      { mode: 'whac-a-mole', modeSettings: { seed: 7, turns: 30 } },
      current,
    );

    expect(validated?.modeSettings.seed).toBe(SETTINGS.seed);
    expect(validated?.modeSettings.turns).toBe(30);
  });

  it('is installed, and offers itself to the lobby', () => {
    expect(getMode('whac-a-mole')).toBe(whacAMole);
    expect(whacAMole.label).toBe('Whac-A-Mole');
    // One more than a player starts with: the janitor's bonus throw needs somewhere to land.
    expect(whacAMole.dartsPerVisit({ ...SETTINGS, darts: 4 })).toBe(5);
  });
});

describe('whac-a-mole: what the screen is told', () => {
  /** Lose a dart down the burrow, then play on until the janitor is up holding it. */
  function untilJanitor(match: MatchState): MatchState {
    let current = submit(throwAt(match, BURROW));
    for (let i = 0; i < 40; i++) {
      if (runOf(current).live.janitor) return current;
      current = idleVisit(current);
    }
    throw new Error('the janitor never came');
  }

  it('draws a full row of slots, with the darts lost to holes shown as lost', () => {
    let match = makeMatch({ digTime: 1 });
    match = idleVisit(match);
    match = submit(throwAt(match, holesOn(match)[0]));

    const slots = whacAMole.view(legContext(match)).slots ?? [];
    expect(slots).toHaveLength((SETTINGS.darts as number) + 1);
    expect(slots.filter((slot) => typeof slot !== 'string' && slot.text === '✖ lost')).toHaveLength(1);

    // The last of them is always the bonus throw, dim until the janitor pays for it.
    expect(slots.at(-1)).toEqual({ text: '🛠 BONUS', tone: 'muted', size: 'sm' });
  });

  it('hands its own component a snapshot, and everyone else a table', () => {
    const match = makeMatch();
    const panel = whacAMole.panel!(match)!;

    expect(panel.rows.map((row) => row.label)).toEqual(['Score', 'Darts left', 'Holes hit']);
    expect(panel.rows[1].values.p1).toBe('3');

    const custom = panel.custom as { phase: string; moles: { label: string }[]; turn: number };
    expect(custom.phase).toBe('playing');
    expect(custom.turn).toBe(1);
    expect(custom.moles).toHaveLength(3);
    expect(JSON.parse(JSON.stringify(panel))).toEqual(panel);   // it has to survive the wire
  });

  it('lights the bonus slot the moment the janitor pays for it', () => {
    const match = untilJanitor(makeMatch({}, 2));
    const before = whacAMole.view(legContext(match)).slots ?? [];
    expect(before.at(-1)).toMatchObject({ tone: 'muted' });

    const after = whacAMole.view(legContext(throwAt(match, BURROW))).slots ?? [];
    // `warning` is the tone nothing else in this row uses; the screen decorates on it.
    expect(after.at(-1)).toEqual({ text: '🛠 BONUS', tone: 'warning', weight: 'bold' });
  });

  it('puts the bonus last however many darts a visit was given', () => {
    const view = whacAMole.view(legContext(makeMatch({ darts: 5 })));
    expect(view.dartsPerVisit).toBe(6);
    expect(view.slots).toHaveLength(6);
    expect(view.slots?.at(-1)).toMatchObject({ text: '🛠 BONUS' });
    expect(whacAMole.dartsPerVisit({ ...SETTINGS, darts: 5 })).toBe(6);
  });

  it('describes the finished run rather than the empty leg left behind it', () => {
    let match = makeMatch({ turns: 1 });
    match = submit(throwAt(match, molesOn(match)[0]));
    expect(match.status).toBe('in_progress');
    match = submit(match);

    expect(match.status).toBe('finished');
    const custom = whacAMole.panel!(match)!.custom as { team: number; phase: string };
    expect(custom.team).toBe(1);
    expect(custom.phase).toBe('finale');
  });
});

// ============================================================
// Any number of players
// ============================================================

describe('whac-a-mole: any number of players', () => {
  it('puts up the same board however many players take the turns', () => {
    // The whole point of counting turns rather than rounds. The colony is a function of the turns
    // played and the darts thrown in them — not of how many people were taking it in turns to
    // throw. Counting rounds, five players saw the same board five times as slowly.
    let a = makeMatch({ turns: 50 }, 1);
    let b = makeMatch({ turns: 50 }, 5);

    for (let i = 0; i < 12; i++) {
      const runA = runOf(a);
      const runB = runOf(b);
      expect(runB.live.moles.map((m) => m.area)).toEqual(runA.live.moles.map((m) => m.area));
      expect(runB.live.moles.map((m) => m.digTime)).toEqual(runA.live.moles.map((m) => m.digTime));
      expect(runB.live.holes).toEqual(runA.live.holes);
      expect(runB.live.escaped).toBe(runA.live.escaped);
      a = idleVisit(a);
      b = idleVisit(b);
    }
  });

  it('runs for the turns it says, and finishes the way round the table it is in', () => {
    // Five divides fifty, so nothing is left over.
    const five = playOut(makeMatch({ turns: 50 }, 5));
    expect(five.visits).toBe(50);
    expect(five.match.visits.filter((v) => v.playerId === 'p1')).toHaveLength(10);
    expect(five.match.visits.filter((v) => v.playerId === 'p5')).toHaveLength(10);

    // Three does not, so the run plays one more rather than stopping with two players a turn ahead.
    const three = playOut(makeMatch({ turns: 50 }, 3));
    expect(three.visits).toBe(51);
    for (const id of ['p1', 'p2', 'p3']) {
      expect(three.match.visits.filter((v) => v.playerId === id)).toHaveLength(17);
    }
  });

  it('enrages the colony on the same turn whatever the roster', () => {
    // turns: 20 puts enraged on turn 12 — ceil(20 * 0.6) — and that is a turn, not a round, so it
    // is the twelfth visit in every one of these.
    const stageOn = (players: number) => {
      let match = makeMatch({ turns: 20 }, players);
      for (let i = 0; i < 11; i++) match = idleVisit(match);
      const custom = whacAMole.panel!(match)!.custom as { turn: number; stage: string; banner?: string };
      return custom;
    };

    for (const players of [1, 2, 5]) {
      expect(stageOn(players)).toMatchObject({ turn: 12, stage: 'enraged', banner: 'enraged' });
    }
  });

  it('names the best of five, and breaks a tie on who kept their darts', () => {
    // One turn each: Carol whacks, nobody else does.
    let match = makeMatch({ turns: 5 }, 5);
    match = idleVisit(match);                                   // Alice
    match = idleVisit(match);                                   // Bob
    match = submit(throwAt(match, molesOn(match)[0]));          // Carol
    match = idleVisit(match);                                   // Dave
    match = idleVisit(match);                                   // Eve

    const finished = submit(match);
    expect(finished.status).toBe('finished');
    expect(finished.winnerId).toBe('p3');
  });

  it('tells the screen about all five of them', () => {
    // What the mode's own component reads: a row value and a card per player, in roster order.
    const match = makeMatch({ turns: 50 }, 5);
    const panel = whacAMole.panel!(match)!;
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];

    for (const row of panel.rows) expect(Object.keys(row.values)).toEqual(ids);
    const custom = panel.custom as { players: { id: string; name: string }[] };
    expect(custom.players.map((p) => p.id)).toEqual(ids);
    expect(custom.players.map((p) => p.name)).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Eve']);
  });

  it('numbers a history line by the turn, without it reading as a treble', () => {
    const match = idleVisit(makeMatch({ turns: 50 }, 3));
    const line = whacAMole.view(legContext(match)).history[0];
    expect(typeof line === 'string' ? line : line.text).toMatch(/^#1 Alice /);
  });
});
