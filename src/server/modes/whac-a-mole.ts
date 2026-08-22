import type {
  DartThrow, MatchState, ModePanel, ModeView, Player, PlayerScoreText, TextTone, ViewText, Visit,
} from '../../shared/types';
import type { ModeSettings, SettingsField } from '../../shared/settings';
import { numberOr, stringOr } from '../../shared/settings';
import type { FinalizedVisit, GameMode, LegContext } from './types';
import { registerMode } from './types';

/**
 * Whac-A-Mole — a co-op highscore training mode, for any number of players.
 *
 * Moles pop up on scoring **areas** and start digging. Hit the area and the mole is whacked; leave it
 * too long and it digs through, and that area is a hole for the rest of the run. Put a dart in a hole
 * and it costs you one dart per visit from your next turn onwards. The run ends when everybody has
 * run out of darts, or when the turns are up, and the score is what the players whacked between them.
 *
 * **A turn is a visit** — this mode's own word for one, because it reads as an arcade machine rather
 * than as a darts match. Everything about the colony is counted in them: how long a run lasts, how
 * far the pressure has climbed, how long a mole takes to dig through. Nothing here counts *rounds*,
 * and that is what lets any number of players share a run: the board a turn puts up is the same
 * board whether two people are taking those turns or five, so the difficulty advances at one rate
 * rather than at one rate per roster size. A five-handed run plays exactly like a solo run of the
 * same length — there are simply more hands in it.
 *
 * What makes it a training mode is what counts as an area: the outer single 18 and the inner single
 * 18 are different places, so "hit the 18" is not an answer. As the run goes on the moles prefer
 * smaller ones, and they get through faster — see `digTimeAt`.
 *
 * The middle of the board is the colony's front door — one area covering both bulls, a hole before
 * the first dart is thrown. It is where every lost dart ends up, and it is the only place one ever
 * comes back from: with a dart down there the **janitor** is in with even odds each visit, holding
 * the oldest of them and looking unimpressed. Whoever hits it gets that dart back for whoever lost
 * it, which is the one move in the game a player makes for their partner. One per visit — the
 * janitor goes home the moment it is whacked, and the middle is a hole again.
 *
 * Like every mode here it **holds no state**: the moles, the holes, the score and who has lost how
 * many darts are all derived by replaying the leg (`replay`) on every call, with a seeded PRNG. That
 * is what makes undo, reconnect and spectating free — three people watching the same leg draw the
 * same three moles because they compute them, not because anybody sent them.
 *
 * One seed decides a run, and it rides in the settings bag (see `defaults`), so every match played
 * from a fresh lobby has its own colony. Two runs on the same seed — a re-match, which copies the
 * previous match's settings, or a second leg — open on the same three moles wearing the same faces,
 * and part company as soon as the first dart lands: every committed visit folds its coordinates back
 * into the PRNG.
 */

// ============================================================
// The board, as this mode divides it
// ============================================================

/**
 * One scoring area: `S20o` outer single, `S20i` inner single, `T20`, `D20`, and `BULL`. Eighty-one
 * of them.
 *
 * The two bulls are one area here, and it is not a target: `BULL` is the colony's front door, a hole
 * before the first dart is thrown and a hole for the rest of the run. See `THE_BURROW`.
 */
type AreaId = string;

/** The middle of the board. Never a mole's target — it is where they all came from. */
const THE_BURROW = 'BULL';

const SECTOR_ORDER = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17,
  3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
];

/**
 * Where the triple ring ends, as a fraction of the board's width.
 *
 * Mirrors `RADII.tripleOuter` in shared/scoring.ts, which is private to that file. It is the one
 * number this mode needs and cannot ask for: a `ScoreResult` says `S18` for both singles, so telling
 * the outer from the inner one takes the dart's coordinates and this radius.
 */
const TRIPLE_OUTER = 107.0 * (0.5 / 225.5);

/** The wire's coordinate space — `BOARD_MAX` in shared/scoring.ts, by definition. */
const BOARD_MAX = 1_000_000;

const OUTER_SINGLES = SECTOR_ORDER.map((n) => `S${n}o`);
const INNER_SINGLES = SECTOR_ORDER.map((n) => `S${n}i`);
const TRIPLES = SECTOR_ORDER.map((n) => `T${n}`);
const DOUBLES = SECTOR_ORDER.map((n) => `D${n}`);

/**
 * The areas grouped by how hard they are to hit, which is also the order the moles come to prefer
 * them in. `TIER_WEIGHTS` says how much, at the start of a run and at the end of one.
 *
 * No bull tier: the middle is a hole throughout, and nothing comes up in a hole.
 */
const TIERS: AreaId[][] = [OUTER_SINGLES, INNER_SINGLES, DOUBLES, TRIPLES];
const TIER_WEIGHTS: [number, number][] = [[60, 10], [30, 20], [7, 40], [3, 30]];

/** Which area a dart landed in, or null for a dart that missed the board entirely. */
function areaOf(dart: DartThrow): AreaId | null {
  const label = dart.score.label;
  if (label === 'SB' || label === 'DB') return THE_BURROW;

  const match = label.match(/^([SDT])(\d+)$/);
  if (!match) return null;
  if (match[1] !== 'S') return label;

  // A single, so it is the radius that decides which of the two it is.
  const r = Math.hypot(dart.x / BOARD_MAX - 0.5, dart.y / BOARD_MAX - 0.5);
  return r > TRIPLE_OUTER ? `S${match[2]}o` : `S${match[2]}i`;
}

/** What an area is called on screen. Short, because it goes in chips and in a one-line notice. */
function labelOf(area: AreaId): string {
  if (area === THE_BURROW) return 'BULL';
  if (area.startsWith('S')) {
    const number = area.slice(1, -1);
    return area.endsWith('i') ? `${number}in` : number;
  }
  return area;
}

/**
 * Every area that touches this one — radially within the sector, and the same ring in the sector
 * either side. Used only to decide whether a dart came close enough for a mole to react to it, which
 * is what makes a near miss feel like a near miss rather than nothing at all.
 */
function neighboursOf(area: AreaId): AreaId[] {
  if (area === THE_BURROW) return [...INNER_SINGLES];

  const ring = area[0];
  const number = ring === 'S' ? Number(area.slice(1, -1)) : Number(area.slice(1));
  const inner = ring === 'S' && area.endsWith('i');
  const index = SECTOR_ORDER.indexOf(number);
  if (index < 0) return [];

  const sideways = [SECTOR_ORDER[(index + 19) % 20], SECTOR_ORDER[(index + 1) % 20]];
  if (ring === 'T') return [`S${number}i`, `S${number}o`, ...sideways.map((n) => `T${n}`)];
  if (ring === 'D') return [`S${number}o`, ...sideways.map((n) => `D${n}`)];
  if (inner) return [THE_BURROW, `T${number}`, ...sideways.map((n) => `S${n}i`)];
  return [`T${number}`, `D${number}`, ...sideways.map((n) => `S${n}o`)];
}

// ============================================================
// Settings
// ============================================================

interface Config {
  /** How long the run is, in turns. A turn is one visit, however many players share them out. */
  turns: number;
  moles: number;
  darts: number;
  digTime: number;
  difficulty: string;
  seed: number;
}

function read(settings: ModeSettings): Config {
  return {
    turns: numberOr(settings, 'turns', 50),
    moles: numberOr(settings, 'moles', 3),
    darts: numberOr(settings, 'darts', 3),
    digTime: numberOr(settings, 'digTime', 3),
    difficulty: stringOr(settings, 'difficulty', 'medium'),
    seed: numberOr(settings, 'seed', 0),
  };
}

const FIELDS: SettingsField[] = [
  {
    key: 'turns',
    label: 'Turns',
    kind: 'number',
    min: 5,
    max: 100,
    options: [
      { value: 20, label: '20 — short' },
      { value: 30, label: '30' },
      { value: 40, label: '40' },
      { value: 50, label: '50 — a full run' },
    ],
  },
  { key: 'moles', label: 'Moles at once', kind: 'number', min: 2, max: 5 },
  { key: 'darts', label: 'Darts per visit', kind: 'number', min: 1, max: 5 },
  { key: 'digTime', label: 'Dig time (turns)', kind: 'number', min: 1, max: 5 },
  {
    key: 'difficulty',
    label: 'Target difficulty',
    kind: 'select',
    options: [
      { value: 'easy', label: 'Easy' },
      { value: 'medium', label: 'Medium' },
      { value: 'hard', label: 'Hard' },
    ],
  },
];

/** Which turn a mole's dig time drops by a visit, and which turn it drops by another. */
function enrageAt(cfg: Config): number {
  return Math.max(2, Math.ceil(cfg.turns * 0.6));
}

function frenzyAt(cfg: Config): number {
  return Math.max(3, Math.ceil(cfg.turns * 0.8));
}

type Stage = 'calm' | 'enraged' | 'frenzy';

function stageAt(turn: number, cfg: Config): Stage {
  if (turn >= frenzyAt(cfg)) return 'frenzy';
  if (turn >= enrageAt(cfg)) return 'enraged';
  return 'calm';
}

/**
 * How many turns a mole spawning on this one takes to dig through.
 *
 * Fixed when the mole spawns rather than read from the current turn, so crossing a threshold never
 * buries a mole that was already halfway down — the board changes for the moles that come next.
 */
function digTimeAt(turn: number, cfg: Config): number {
  const stage = stageAt(turn, cfg);
  if (stage === 'frenzy') return Math.max(1, cfg.digTime - 2);
  if (stage === 'enraged') return Math.max(1, cfg.digTime - 1);
  return cfg.digTime;
}

/**
 * How many moles in one visit is a clean sweep.
 *
 * The whole board, or every dart in hand — whichever runs out first. A literal three was right for
 * the settings it was written against and wrong either side of them: at two moles a visit it could
 * never be reached, and at five it paid out for clearing three of them, which is not a sweep.
 */
function sweepAt(cfg: Config): number {
  return Math.min(cfg.moles, cfg.darts);
}

/**
 * The most a team could possibly score, from the settings alone.
 *
 * A turn is worth the moles it can reach — `min(darts, moles)`, since neither a dart without a mole
 * nor a mole without a dart pays — plus one for the sweep, which `sweepAt` sets to exactly that
 * number. Nothing else can be earned: the janitor pays in darts rather than points, and it is only
 * ever in when a dart has already been lost, which a flawless run never does.
 *
 * The turn count is rounded up to a whole way round the table, because that is the run `isOver`
 * actually plays — three players in a fifty-turn run play fifty-one, and the fifty-first is worth
 * as much as any other.
 *
 * A fact about the settings, not about the run: it is the same number before the first dart as
 * after the last, which is what makes the share of it worth showing.
 */
function maxScoreOf(cfg: Config, players: number): number {
  const seats = Math.max(1, players);
  const turns = Math.ceil(cfg.turns / seats) * seats;
  return turns * (Math.min(cfg.darts, cfg.moles) + 1);
}

/** How far the difficulty has climbed, 0 on the first turn and 1 on the last. */
function pressureAt(turn: number, cfg: Config): number {
  const linear = Math.min(1, Math.max(0, (turn - 1) / Math.max(1, cfg.turns - 1)));
  if (cfg.difficulty === 'easy') return linear ** 1.8;
  if (cfg.difficulty === 'hard') return linear ** 0.55;
  return linear;
}

// ============================================================
// The PRNG
// ============================================================

function hashText(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Stir one more number into a seed. */
function mix(seed: number, value: number): number {
  let h = (seed ^ Math.imul(value >>> 0, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** One draw in [0, 1), advancing the state it is given. mulberry32. */
function draw(state: number): { value: number; state: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: next };
}

// ============================================================
// The run, replayed
// ============================================================

export interface Mole {
  id: number;
  area: AreaId;
  /** The visit this mole came up in. */
  born: number;
  /** Visits it takes to dig through. */
  digTime: number;
}

export type RunEventKind = 'spawn' | 'whack' | 'perfect' | 'near' | 'hole' | 'escape' | 'rescue';

export interface RunEvent {
  kind: RunEventKind;
  area: AreaId;
  /** Which dart of the visit caused it, where one did. */
  dart?: number;
  /** The mole it happened to, where there is one. */
  moleId?: number;
  playerId?: string;
  /** Whose dart came back, on a rescue. Not necessarily the player who threw. */
  ownerId?: string;
}

export interface Run {
  rng: number;
  moles: Mole[];
  /**
   * Every area dug through, oldest first. The burrow is there before anybody throws, so the moles
   * that got away number `holes.length - 1` — which is why that is not counted separately.
   */
  holes: AreaId[];
  score: Record<string, number>;
  whacks: Record<string, number>;
  holesHit: Record<string, number>;
  rescued: Record<string, number>;
  /** Who lost each dart still down the burrow, oldest first. The janitor hands them back in order. */
  lost: string[];
  /** Whether the janitor is up this visit, holding the oldest of them. */
  janitor: boolean;
  /** Visits committed so far — the index of the visit about to be played. */
  visitIndex: number;
  nextMoleId: number;
  perfectVisits: number;
  /** Everything that happened in the visit being played. Cleared as each one begins. */
  events: RunEvent[];
  /** Areas dug through at the end of the previous visit, so the screen can show it happening. */
  buried: AreaId[];
  history: { text: string; tone: TextTone }[];
}

function freshRun(ctx: LegContext, cfg: Config): Run {
  const zeroed = () => Object.fromEntries(ctx.players.map((p) => [p.id, 0]));
  return {
    // The whole run comes from one number, and the settings bag is how it gets here — see
    // `defaults`. Two runs on the same seed open on the same three moles and part company as soon
    // as the first dart lands, because every committed visit folds its coordinates back in.
    rng: mix(0, cfg.seed),
    moles: [],
    holes: [THE_BURROW],
    score: zeroed(),
    whacks: zeroed(),
    holesHit: zeroed(),
    rescued: zeroed(),
    lost: [],
    janitor: false,
    visitIndex: 0,
    nextMoleId: 1,
    perfectVisits: 0,
    events: [],
    buried: [],
    history: [],
  };
}

function cloneRun(run: Run): Run {
  return {
    ...run,
    moles: [...run.moles],
    holes: [...run.holes],
    score: { ...run.score },
    whacks: { ...run.whacks },
    holesHit: { ...run.holesHit },
    rescued: { ...run.rescued },
    lost: [...run.lost],
    events: [...run.events],
    buried: [...run.buried],
    history: [...run.history],
  };
}

/**
 * Which turn a visit is, counting from one. A turn **is** a visit — this mode's word for one.
 *
 * An identity, and named anyway: it is the seam where the roster used to come in. The curve was once
 * read off the round a visit fell in, which made how fast it climbed a function of how many people
 * were playing. Everything below asks for the turn instead, and gets an answer that does not know
 * the roster exists.
 */
function turnOf(visitIndex: number): number {
  return visitIndex + 1;
}

/** How many darts this player may throw, given what they have dropped into holes. */
function allowanceOf(run: Run, playerId: string, cfg: Config): number {
  return Math.max(0, cfg.darts - (run.holesHit[playerId] ?? 0));
}

/**
 * The bonus throw: one extra dart, this visit only, for prising a dart off the janitor.
 *
 * Only ever one, because the janitor goes home the moment it is hit and there is at most one of it
 * a visit. That ceiling is what `dartsPerVisit` is set from — see there.
 */
function bonusIn(run: Run, playerId: string): number {
  return run.events.some((event) => event.kind === 'rescue' && event.playerId === playerId) ? 1 : 0;
}

/** What the thrower may still put on the board this visit, the bonus throw included. */
function liveAllowance(start: Run, live: Run, playerId: string, cfg: Config): number {
  return allowanceOf(start, playerId, cfg) + bonusIn(live, playerId);
}

/**
 * Whether the run is over, asked at the start of a visit.
 *
 * Either everybody has thrown their last dart into a hole, or the turns are up. That visit is then
 * the curtain call: nothing to throw, and submitting it ends the leg.
 *
 * The turns being up is not quite enough on its own: a run stops at the end of a **full way round
 * the table**, so nobody is cut off having had a turn fewer than the player beside them. Three
 * players in a fifty-turn run therefore play fifty-one. The lobby still offers the fifty it asked
 * for, which is the honest number to choose between even if it is not always the number played.
 *
 * A **departed** player is skipped by the match layer, so from that point on the visits stop
 * dividing evenly and this can land a turn late. Counting rounds had exactly the same hole; it is
 * carried over rather than introduced, and a co-op run whose partner walked out has bigger problems.
 */
function isOver(run: Run, ctx: LegContext, cfg: Config): boolean {
  const players = Math.max(1, ctx.players.length);
  if (run.visitIndex >= cfg.turns && run.visitIndex % players === 0) return true;
  return ctx.players.every((p) => allowanceOf(run, p.id, cfg) === 0);
}

/**
 * How often the janitor is in, when there is a dart down there for it to be cross about.
 */
const JANITOR_CHANCE = 0.5;

/** Top up to a full set of moles. Two never share an area, and none ever comes up in a hole. */
function beginVisit(run: Run, cfg: Config): void {
  run.events = [];
  const turn = turnOf(run.visitIndex);

  // The janitor first, so the roll happens in the same order however many moles are due.
  run.janitor = false;
  if (run.lost.length > 0) {
    const roll = draw(run.rng);
    run.rng = roll.state;
    run.janitor = roll.value < JANITOR_CHANCE;
    if (run.janitor) run.events.push({ kind: 'spawn', area: THE_BURROW, ownerId: run.lost[0] });
  }

  const taken = new Set([...run.holes, ...run.moles.map((m) => m.area)]);
  const pressure = pressureAt(turn, cfg);

  while (run.moles.length < cfg.moles) {
    const area = pickArea(run, taken, pressure);
    if (!area) break;
    taken.add(area);
    run.moles.push({ id: run.nextMoleId++, area, born: run.visitIndex, digTime: digTimeAt(turn, cfg) });
    run.events.push({ kind: 'spawn', area });
  }
}

/**
 * One area for a mole to come up in: a tier by weight, then an area inside it.
 *
 * A tier with nothing free contributes no weight, which is what redistributes a board whose doubles
 * are all holes back onto the ones that are left.
 */
function pickArea(run: Run, taken: Set<AreaId>, pressure: number): AreaId | null {
  const free = TIERS.map((tier) => tier.filter((area) => !taken.has(area)));
  const weights = TIER_WEIGHTS.map(([start, end], i) =>
    free[i].length === 0 ? 0 : start + (end - start) * pressure);

  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return null;

  const tierRoll = draw(run.rng);
  run.rng = tierRoll.state;
  let cursor = tierRoll.value * total;
  let tier = weights.length - 1;
  for (let i = 0; i < weights.length; i++) {
    cursor -= weights[i];
    if (cursor <= 0) {
      tier = i;
      break;
    }
  }

  const areaRoll = draw(run.rng);
  run.rng = areaRoll.state;
  return free[tier][Math.floor(areaRoll.value * free[tier].length)] ?? null;
}

/**
 * Play a visit's darts against the board.
 *
 * Darts past the thrower's allowance are ignored rather than trusted: at the start of a visit there
 * is no `currentVisit` for the match layer to see a lock on, so a player with nothing left could
 * still get one dart as far as the server, and this is where it stops counting.
 */
function applyDarts(
  run: Run,
  darts: DartThrow[],
  playerId: string,
  cfg: Config,
  allowance: number,
): void {
  let whacks = 0;
  // Grows the moment the janitor is whacked, which is why the bound is inside the loop: a rescue
  // with the last dart in hand has to open the next one.
  let bonus = 0;

  for (let i = 0; i < darts.length; i++) {
    if (i >= allowance + bonus) break;
    const area = areaOf(darts[i]);
    if (!area) continue;

    const mole = run.moles.find((m) => m.area === area);
    if (mole) {
      run.moles = run.moles.filter((m) => m.id !== mole.id);
      run.score[playerId] = (run.score[playerId] ?? 0) + 1;
      run.whacks[playerId] = (run.whacks[playerId] ?? 0) + 1;
      whacks++;
      run.events.push({ kind: 'whack', area, dart: i, moleId: mole.id, playerId });
      continue;
    }

    // The janitor is holding somebody's dart over the burrow. Whack it and that dart goes back to
    // whoever lost it — which need not be the player who threw, and is the whole point of it.
    if (area === THE_BURROW && run.janitor) {
      const ownerId = run.lost.shift()!;
      run.janitor = false;
      run.holesHit[ownerId] = Math.max(0, (run.holesHit[ownerId] ?? 0) - 1);
      run.rescued[playerId] = (run.rescued[playerId] ?? 0) + 1;
      // No point for it, and it is not a whack: a turn is worth the moles that came up plus the
      // sweep for clearing them, and a janitor that scored would be a point the board never put
      // up. What it pays is the dart — back to its owner next visit, and in this player's hand
      // right now.
      bonus = 1;
      run.events.push({ kind: 'rescue', area, dart: i, playerId, ownerId });
      continue;
    }

    if (run.holes.includes(area)) {
      run.holesHit[playerId] = (run.holesHit[playerId] ?? 0) + 1;
      run.lost.push(playerId);
      run.events.push({ kind: 'hole', area, dart: i, playerId });
      continue;
    }

    // Close enough for whoever is next door to have felt it.
    const neighbours = neighboursOf(area);
    const startled = run.moles.find((m) => neighbours.includes(m.area));
    if (startled) {
      run.events.push({ kind: 'near', area: startled.area, dart: i, moleId: startled.id, playerId });
    }
  }

  if (whacks >= sweepAt(cfg)) {
    run.score[playerId] = (run.score[playerId] ?? 0) + 1;
    run.perfectVisits++;
    run.events.push({ kind: 'perfect', area: '', playerId });
  }
}

/** Age every mole left standing, and bury the ones whose dig time is up. */
function endVisit(run: Run): void {
  const buried: AreaId[] = [];

  run.moles = run.moles.filter((mole) => {
    if (run.visitIndex - mole.born + 1 < mole.digTime) return true;
    buried.push(mole.area);
    run.holes.push(mole.area);
    run.events.push({ kind: 'escape', area: mole.area, moleId: mole.id });
    return false;
  });

  run.buried = buried;
  // The janitor only ever stands there for the one visit; whether it is back is next visit's roll.
  run.janitor = false;
  run.visitIndex++;
}

/** Stir the visit that was just played into the seed, so no two runs stay alike for long. */
function foldVisit(run: Run, darts: DartThrow[]): void {
  run.rng = mix(run.rng, run.visitIndex * 31 + darts.length);
  for (const dart of darts) {
    run.rng = mix(mix(run.rng, dart.x), dart.y);
  }
}

/**
 * The whole leg, replayed.
 *
 * `start` is the board as the current visit found it — which is what the thrower's allowance and the
 * end of the run are read off, so that neither can change under a dart. `live` is that board with the
 * darts thrown so far applied, which is what is drawn.
 */
function replay(ctx: LegContext): { start: Run; live: Run; over: boolean; cfg: Config } {
  const cfg = read(ctx.settings);
  const run = freshRun(ctx, cfg);

  for (const visit of ctx.visits) {
    beginVisit(run, cfg);
    applyDarts(run, visit.darts, visit.playerId, cfg, allowanceOf(run, visit.playerId, cfg));
    foldVisit(run, visit.darts);
    endVisit(run);
    run.history.push(describeVisit(run, ctx, visit));
  }

  const over = isOver(run, ctx, cfg);
  if (!over) beginVisit(run, cfg);
  else run.events = [];

  const start = cloneRun(run);
  const cv = ctx.currentVisit;
  if (cv && !over) {
    applyDarts(run, cv.darts, cv.playerId, cfg, allowanceOf(start, cv.playerId, cfg));
  }

  return { start, live: run, over, cfg };
}

/** Whose run it goes down as. Co-op, so this is bookkeeping — the team total is the score. */
function winnerOf(run: Run, players: Player[]): string {
  let best = players[0];
  for (const player of players.slice(1)) {
    const better = (run.score[player.id] ?? 0) - (run.score[best.id] ?? 0);
    if (better > 0) best = player;
    else if (better === 0 && (run.holesHit[player.id] ?? 0) < (run.holesHit[best.id] ?? 0)) best = player;
  }
  return best.id;
}

// ============================================================
// The mode
// ============================================================

/** A number nobody has to look at, and nobody may set. See the `seed` note on `defaults`. */
function freshSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

export const whacAMole: GameMode = {
  id: 'whac-a-mole',
  label: 'Whac-A-Mole',

  /**
   * A fresh `seed` every time this is read, which is what gives each match its own colony.
   *
   * The rules half of a mode never sees the match — `LegContext` has no match id and no leg number —
   * so the only way a per-match number can reach them is to be a setting. `validateSettings` copies
   * these defaults when the lobby switches mode, which stamps one seed into the lobby and leaves it
   * alone from then on.
   *
   * `seed` is deliberately absent from `fields`, which is what makes it unsettable: the validator
   * reads declared fields and nothing else, so no message can choose it, and the lobby never draws
   * a box for it. A default with no field is the same shape x01 uses for its `stats` knob in a
   * production build.
   */
  get defaults(): ModeSettings {
    return { turns: 50, moles: 3, darts: 3, digTime: 3, difficulty: 'medium', seed: freshSeed() };
  },

  fields: FIELDS,

  // The moles are drawn onto the board's own geometry, and a camera picture of a real board cannot
  // be lined up with it — the overlay would sit on a photograph of somewhere else. Evidence stills
  // are untouched: they are a strip under the slots and have nothing to do with the board's SVG.
  bansMedia: ['boardVideo'],

  /**
   * The most darts a visit could ever hold, which is one more than a player starts with: the
   * janitor pays a bonus throw, and it can only ever pay one.
   *
   * This is the match layer's hard cap and it cannot see a visit, so it has to be the ceiling
   * rather than the allowance. What a given visit actually permits is `isVisitLocked`'s business,
   * and a dart squeezed past it counts for nothing — `applyDarts` stops reading at the allowance
   * and `finalizeVisit` cuts the rest off.
   */
  dartsPerVisit(settings: ModeSettings): number {
    return read(settings).darts + 1;
  },

  isVisitLocked(ctx: LegContext): boolean {
    const { start, live, over, cfg } = replay(ctx);
    const playerId = ctx.currentVisit?.playerId ?? ctx.currentPlayerId;
    const allowance = over ? 0 : liveAllowance(start, live, playerId, cfg);
    return (ctx.currentVisit?.darts.length ?? 0) >= allowance;
  },

  finalizeVisit(ctx: LegContext): FinalizedVisit {
    const { start, live, over, cfg } = replay(ctx);
    const playerId = ctx.currentVisit?.playerId ?? ctx.currentPlayerId;
    const allowance = over ? 0 : liveAllowance(start, live, playerId, cfg);

    // Exactly the darts that counted — the bonus throw included, or a rescue with the last dart in
    // hand would be cut off here having earned the throw it just made. No padding: a turn here is
    // worth what was thrown in it, and a player down to one dart has not somehow thrown three.
    const visit: Visit = {
      playerId,
      darts: (ctx.currentVisit?.darts ?? []).slice(0, allowance),
      visitNumber: ctx.visits.length + 1,
      voided: false,
    };

    // A leg always ends with a winner, and the curtain-call visit is where this one does.
    return { visit, legWinnerId: over ? winnerOf(live, ctx.players) : null };
  },

  view(ctx: LegContext): ModeView {
    const { start, live, over, cfg } = replay(ctx);
    const playerId = ctx.currentVisit?.playerId ?? ctx.currentPlayerId;
    const allowance = over ? 0 : liveAllowance(start, live, playerId, cfg);
    const thrown = ctx.currentVisit?.darts ?? [];
    // Moles only. The janitor pays in darts, not in points.
    const whacks = live.events.filter((e) => e.kind === 'whack').length;
    const perfect = live.events.some((e) => e.kind === 'perfect');

    const playerScores: Record<string, PlayerScoreText> = {};
    for (const player of ctx.players) {
      const out = !over && allowanceOf(start, player.id, cfg) === 0;
      playerScores[player.id] = out
        ? { text: String(live.score[player.id] ?? 0), tone: 'muted' }
        : String(live.score[player.id] ?? 0);
    }

    return {
      headline: '🔨 Whac-A-Mole',
      notice: noticeFor(start, live, over, allowance, ctx, cfg),
      playerScores,
      visitTotal: `🔨 ${whacks}${perfect ? ' +1' : ''}`,
      // The row is as long as a visit can ever be, so the bonus slot has a place to sit whether or
      // not it has been earned — see `slotsFor`, which always fills the last one.
      dartsPerVisit: cfg.darts + 1,
      slots: slotsFor(thrown, live, allowanceOf(start, playerId, cfg), cfg, playerId),
      history: [...live.history].reverse(),
    };
  },

  /**
   * The mode's own block. Everything the screen draws comes from here, and it is handed the match
   * rather than a leg because a finished one has already moved its visits out of the current leg.
   *
   * `rows` is not decoration: a deployment without the client half renders them as a plain table, and
   * the run is still perfectly playable off it.
   */
  panel(match: MatchState): ModePanel | undefined {
    const finished = match.status !== 'in_progress';
    // A finished match has already moved its leg into `legs`, so replaying the current one would
    // describe a run nobody played. The last completed leg is the one that just ended.
    const visits = finished && match.legs.length > 0
      ? match.legs[match.legs.length - 1].visits
      : match.visits;

    const ctx: LegContext = {
      settings: match.settings.modeSettings,
      players: match.players,
      currentPlayerId: match.currentVisit?.playerId
        ?? match.players[match.currentPlayerIndex]?.id
        ?? match.players[0]?.id
        ?? '',
      visits,
      currentVisit: finished ? undefined : match.currentVisit,
    };

    const { start, live, over, cfg } = replay(ctx);
    // Clamped, because a run finishes the way round the table it is in and can overrun the number
    // the lobby asked for. "Turn 51 / 50" is true and reads like a fault.
    const turn = Math.min(cfg.turns, turnOf(start.visitIndex));
    const team = match.players.reduce((sum, p) => sum + (live.score[p.id] ?? 0), 0);
    // Turns the score has had to happen in: the ones played, and the one being played while there
    // is one. Counting the turn in hand is what lets this move as the darts land rather than
    // sitting still until somebody submits — and once the run is over there is no turn in hand, so
    // the divisor is the run's real length rather than the curtain call's number.
    const turnsTaken = Math.max(1, over ? start.visitIndex : turnOf(start.visitIndex));
    const current = ctx.currentPlayerId;
    const allowance = over ? 0 : allowanceOf(start, current, cfg);

    const values = (of: (playerId: string) => string) =>
      Object.fromEntries(match.players.map((p) => [p.id, of(p.id)] as const));

    return {
      title: 'Whac-A-Mole',
      render: 'auto',
      rows: [
        { label: 'Score', values: values((id) => String(live.score[id] ?? 0)) },
        { label: 'Darts left', values: values((id) => String(allowanceOf(start, id, cfg))) },
        { label: 'Holes hit', values: values((id) => String(start.holesHit[id] ?? 0)) },
      ],
      custom: {
        phase: over ? 'finale' : allowance === 0 ? 'pass' : 'playing',
        turn,
        turns: cfg.turns,
        stage: stageAt(turn, cfg),
        moleCount: cfg.moles,
        banner: bannerFor(turn, cfg),
        team,
        players: match.players.map((p) => ({
          id: p.id,
          name: p.name,
          score: live.score[p.id] ?? 0,
          allowance: allowanceOf(start, p.id, cfg),
          darts: cfg.darts,
          out: allowanceOf(start, p.id, cfg) === 0,
          isCurrent: !over && p.id === current,
          returning: live.events.filter((e) => e.kind === 'rescue' && e.ownerId === p.id).length,
        })),
        moles: live.moles.map((mole) => {
          const reaction = live.events.find((e) => e.kind === 'near' && e.moleId === mole.id);
          return {
            id: mole.id,
            area: mole.area,
            label: labelOf(mole.area),
            age: start.visitIndex - mole.born,
            digTime: mole.digTime,
            enraged: mole.digTime < cfg.digTime,
            variant: pickIndex(cfg.seed, `mole:${mole.id}:${mole.area}`, MOLE_VARIANTS),
            reaction: reaction
              ? NEAR_REACTIONS[pickIndex(cfg.seed, `near:${mole.id}:${reaction.dart}`, NEAR_REACTIONS.length)]
              : undefined,
          };
        }),
        holes: live.holes.map((area) => ({ area, label: labelOf(area) })),
        burrow: THE_BURROW,
        // Up for this visit only, holding the oldest dart down there. `queue` is how many more are
        // waiting behind it, which is what says whether one rescue fixes the team or barely dents it.
        janitor: live.janitor
          ? {
              ownerId: live.lost[0],
              ownerName: match.players.find((p) => p.id === live.lost[0])?.name ?? '',
              queue: live.lost.length,
              grumble: JANITOR_GRUMBLES[pickIndex(cfg.seed, `janitor:${live.lost.length}:${turn}`, JANITOR_GRUMBLES.length)],
            }
          : null,
        lost: live.lost.length,
        events: live.events.map((event) => ({
          ...event,
          label: event.area ? labelOf(event.area) : '',
          call: callFor(cfg.seed, event),
        })),
        buried: live.buried,
        // What a flawless run of these settings would score, so the team total means something on
        // its own. Sent as the number rather than as a share of it: the screen has the total
        // already, and one of the two is a fact while the other is a rendering of it.
        maxScore: maxScoreOf(cfg, match.players.length),
        stats: {
          whacked: match.players.reduce((sum, p) => sum + (live.whacks[p.id] ?? 0), 0),
          perfectVisits: live.perfectVisits,
          holes: live.holes.length,
          rescued: match.players.reduce((sum, p) => sum + (live.rescued[p.id] ?? 0), 0),
          // Points per turn, against a ceiling of `min(darts, moles) + 1` — four by default. The
          // one figure here that is a rate rather than a tally, and the one that says whether a
          // run is going well while it is still going.
          ppt: team / turnsTaken,
        },
      },
    };
  },
};

// ============================================================
// Display. Nothing below here is a rule.
// ============================================================

const MOLE_VARIANTS = 3;

const NEAR_REACTIONS = [
  { kind: 'duck', text: 'Missed me!' },
  { kind: 'taunt', text: 'Nyeh nyeh!' },
  { kind: 'laugh', text: 'Hehehe' },
  { kind: 'sweat', text: 'Yikes!' },
  { kind: 'peek', text: 'Warmer…' },
];

const WHACK_CALLS = ['BONK!', 'WHAM!', 'OOF!', 'POW!', 'THWACK!'];
const HOLE_CALLS = ['Thanks for the dart!', 'Nom nom.', 'Finders keepers!', 'Mine now.'];
const ESCAPE_CALLS = ['See ya!', 'Too slow!', 'Dug it!'];
const RESCUE_CALLS = ['SAVED!', 'GOT IT!', 'HANDS OFF!'];

/** What the janitor has to say about the dart it is holding. */
const JANITOR_GRUMBLES = ['This is mine now.', 'Lost something?', 'Come and get it.', 'Finders keepers.'];

/**
 * A stable choice out of a list, for anything that is only ever drawn.
 *
 * The same seed the rules run on, so everyone watching computes the same reaction and nothing has
 * to be smuggled in from outside the mode. The keys carry a mole's id and the area it came up in,
 * both of which the darts have already moved, so two runs on one seed are only ever alike for as
 * long as their boards are.
 */
function pickIndex(seed: number, key: string, length: number): number {
  return hashText(`${seed}:${key}`) % length;
}

function callFor(seed: number, event: RunEvent): string {
  if (event.kind === 'whack') return WHACK_CALLS[pickIndex(seed, `whack:${event.moleId}`, WHACK_CALLS.length)];
  if (event.kind === 'hole') return HOLE_CALLS[pickIndex(seed, `hole:${event.area}:${event.dart}`, HOLE_CALLS.length)];
  if (event.kind === 'escape') return ESCAPE_CALLS[pickIndex(seed, `escape:${event.moleId}`, ESCAPE_CALLS.length)];
  if (event.kind === 'rescue') return RESCUE_CALLS[pickIndex(seed, `rescue:${event.dart}:${event.ownerId}`, RESCUE_CALLS.length)];
  return '';
}

/**
 * Shown once, on the turn that changed how patient the moles are.
 *
 * Once by construction: a threshold is a single turn, and a turn happens once. This used to have to
 * guard against firing again for every player in the round it landed in.
 */
function bannerFor(turn: number, cfg: Config): Stage | undefined {
  if (turn === frenzyAt(cfg)) return 'frenzy';
  if (turn === enrageAt(cfg)) return 'enraged';
  return undefined;
}

function noticeFor(
  start: Run,
  live: Run,
  over: boolean,
  allowance: number,
  ctx: LegContext,
  cfg: Config,
): ViewText {
  if (over) return { text: 'GAME OVER — submit to finish', tone: 'warning' };
  if (allowance === 0) return { text: 'Out of darts — submit to pass', tone: 'danger' };

  // The janitor outranks everything else on the board: it is the only way a lost dart comes back,
  // and it is gone at the end of this visit whatever happens.
  if (live.janitor) {
    const owner = ctx.players.find((p) => p.id === live.lost[0]);
    const whose = owner?.id === ctx.currentPlayerId ? 'your' : `${owner?.name ?? 'a'}'s`;
    return { text: `🛠 The janitor has ${whose} dart — hit the BULL to get it back!`, tone: 'warning' };
  }

  const stage = stageAt(turnOf(start.visitIndex), cfg);
  if (live.moles.length === 0) {
    return { text: 'Board clear! Submit to bring the next lot up', tone: 'positive' };
  }

  const targets = live.moles.map((m) => labelOf(m.area)).join(' · ');
  const prefix = stage === 'frenzy' ? 'FRENZY! ' : stage === 'enraged' ? 'Enraged! ' : '';
  return {
    text: `${prefix}${live.moles.length} digging — ${targets}`,
    tone: stage === 'calm' ? 'accent' : 'warning',
  };
}

/**
 * The dart slots: what was thrown, then what is left to throw, then the darts this player has lost.
 *
 * Always exactly a full row, so a player who is down to one dart sees the two they dropped in a hole
 * sitting there rather than an empty slot they might still aim at.
 */
function slotsFor(
  thrown: DartThrow[],
  live: Run,
  budget: number,
  cfg: Config,
  playerId: string,
): ViewText[] {
  const outcome = (dart: DartThrow, i: number): ViewText => {
    const event = live.events.find(
      (e) => e.dart === i && (e.kind === 'whack' || e.kind === 'hole' || e.kind === 'rescue'),
    );
    if (event?.kind === 'whack') return { text: `🔨 ${labelOf(event.area)}`, tone: 'positive' };
    if (event?.kind === 'rescue') return { text: '🛠 SAVED', tone: 'positive' };
    if (event?.kind === 'hole') return { text: `🕳 ${labelOf(event.area)}`, tone: 'danger' };
    return { text: dart.score.label, tone: 'muted' };
  };

  const slots: ViewText[] = thrown.slice(0, budget).map(outcome);

  while (slots.length < budget) slots.push({ text: '·', tone: 'muted' });

  // Darts handed back this visit are back next visit, not gone: the row says so rather than
  // sitting there reading "lost" about a dart the player has just watched come out of the burrow.
  const returning = live.events.filter((e) => e.kind === 'rescue' && e.ownerId === playerId).length;
  const lost = cfg.darts - budget;
  for (let i = 0; i < lost; i++) {
    slots.push(i < returning ? { text: '↺ back', tone: 'accent' } : { text: '✖ lost', tone: 'danger' });
  }

  // The bonus throw is always the last slot, whatever happened to the ones before it — the screen
  // decorates it by position, and a slot that moved around would be decorating something else.
  // `warning` is the tone no other slot uses, which is how the screen knows it is live.
  const bonus = thrown[budget];
  if (bonus) slots.push(outcome(bonus, budget));
  else if (bonusIn(live, playerId)) slots.push({ text: '🛠 BONUS', tone: 'warning', weight: 'bold' });
  else slots.push({ text: '🛠 BONUS', tone: 'muted', size: 'sm' });

  return slots;
}

/** Two names and a count, so one bad visit does not wrap the history three lines deep. */
function listOf(names: string[]): string {
  if (names.length <= 2) return names.join(' ');
  return `${names.slice(0, 2).join(' ')} and ${names.length - 2} more`;
}

function describeVisit(run: Run, ctx: LegContext, visit: Visit): { text: string; tone: TextTone } {
  const name = ctx.players.find((p) => p.id === visit.playerId)?.name ?? '?';
  const turn = turnOf(run.visitIndex - 1);
  const whacks = run.events.filter((e) => e.kind === 'whack' || e.kind === 'rescue');
  const holes = run.events.filter((e) => e.kind === 'hole');
  const escapes = run.events.filter((e) => e.kind === 'escape');
  const rescues = run.events.filter((e) => e.kind === 'rescue');
  const perfect = run.events.some((e) => e.kind === 'perfect');

  const parts = [`${whacks.length} whack${whacks.length === 1 ? '' : 's'}`];
  if (perfect) parts.push('PERFECT +1');
  if (rescues.length > 0) {
    const owner = ctx.players.find((p) => p.id === rescues[0].ownerId)?.name ?? 'a';
    parts.push(`🛠 saved ${owner}'s dart`);
  }
  if (holes.length > 0) parts.push(`🕳 ${listOf(holes.map((e) => labelOf(e.area)))}`);
  if (escapes.length > 0) parts.push(`escaped ${listOf(escapes.map((e) => labelOf(e.area)))}`);

  return {
    // `#12`, not `T12` — a T in front of a number is a treble everywhere else on this screen.
    text: `#${turn} ${name}  ${parts.join(' · ')}`,
    tone: rescues.length > 0
      ? 'positive'
      : holes.length > 0
        ? 'danger'
        : perfect
          ? 'positive'
          : escapes.length > 0
            ? 'warning'
            : 'default',
  };
}

// --- This mode's own helpers, for its tests. Not part of the contract. ---

export function whacRun(ctx: LegContext): { start: Run; live: Run; over: boolean } {
  return replay(ctx);
}

export function whacAreaOf(dart: DartThrow): AreaId | null {
  return areaOf(dart);
}

registerMode(whacAMole);
