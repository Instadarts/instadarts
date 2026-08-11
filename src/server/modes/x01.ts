import type {
  CurrentVisit, DartThrow, MatchState, ModePanel, ModeView, StyledText, ViewText, Visit,
} from '../../shared/types';
import type { ModeSettings, SettingsField } from '../../shared/settings';
import { boolOr, numberOr, stringOr } from '../../shared/settings';
import type { FinalizedVisit, GameMode, LegContext } from './types';
import { registerMode } from './types';
import { IS_DEV } from '../env';

/**
 * x01 game mode (301, 501, 701, …).
 *
 * Rules:
 * - Players start at the configured startScore.
 * - Each visit has 3 dart slots.
 * - If doubleIn is set, the first scoring dart must be a double; non-double darts before the double
 *   score 0, and the entire visit is void if no double was hit.
 * - If doubleOut is set, the winning dart must be a double that brings the score exactly to 0.
 * - Bust: the visit total would take remaining below 0, or — under doubleOut — would leave exactly 1
 *   (unfinishable, since no double is worth one) or would reach 0 on a non-double.
 *
 * Everything here is derived from the leg's visit history. There is deliberately no state: whether a
 * player has doubled in is a question the history already answers, and holding the answer anywhere
 * else is what used to make it outlive the leg it belonged to.
 */

const MAX_DARTS = 3;

/**
 * x01's own settings, read out of the untyped bag the mode is handed. Values arriving from a client
 * have already been validated against the fields x01 declares in shared/modes/catalog.ts; the
 * fallbacks here are for a settings object built by anything else.
 */
interface X01Settings {
  startScore: number;
  doubleIn: boolean;
  doubleOut: boolean;
}

function read(settings: ModeSettings): X01Settings {
  return {
    startScore: numberOr(settings, 'startScore', 501),
    doubleIn: boolOr(settings, 'doubleIn', false),
    doubleOut: boolOr(settings, 'doubleOut', true),
  };
}

// ============================================================
// Derivations
// ============================================================

function isDouble(dart: DartThrow): boolean {
  return dart.score.mult === 2 || dart.score.label === 'DB';
}

function pointsOf(darts: DartThrow[]): number {
  return darts.reduce((sum, d) => sum + d.score.points, 0);
}

/** What a player has left, from the committed visits alone. */
function remainingFor(ctx: LegContext, playerId: string): number {
  let remaining = read(ctx.settings).startScore;
  for (const visit of ctx.visits) {
    if (visit.playerId !== playerId || visit.voided) continue;
    remaining -= pointsOf(visit.darts);
  }
  return Math.max(0, remaining);
}

/**
 * Whether a player has satisfied double-in.
 *
 * Derived rather than remembered: a visit that never hit a double is committed void, and a visit
 * that hit one and then busted is committed void too — so "has a committed non-void visit containing
 * a double" is exactly the flag this used to keep. Note it is *containing a double*, not merely
 * non-void: a zero-dart submit commits three misses as a non-void visit and must not open the door.
 */
function hasDoubledIn(ctx: LegContext, playerId: string): boolean {
  return ctx.visits.some(
    (visit) => visit.playerId === playerId && !visit.voided && visit.darts.some(isDouble),
  );
}

/**
 * Whether a visit leaving this much is dead.
 *
 * Overthrowing always is. Leaving exactly one is too — but only under double-out, where there is no
 * double worth one to finish on. A straight-out game checks it out with a single 1.
 */
function isBustScore(remainingAfter: number, doubleOut: boolean): boolean {
  if (remainingAfter < 0) return true;
  return doubleOut && remainingAfter === 1;
}

function isNoDoubleCheckout(lastDart: DartThrow, doubleOut: boolean, remainingAfter: number): boolean {
  return doubleOut && remainingAfter === 0 && !isDouble(lastDart);
}

/** What these darts are actually worth, honouring an unmet double-in. */
function effectiveScore(ctx: LegContext, playerId: string, darts: DartThrow[]): number {
  if (!read(ctx.settings).doubleIn || hasDoubledIn(ctx, playerId)) return pointsOf(darts);

  let effective = 0;
  let doubleHit = false;
  for (const dart of darts) {
    if (!doubleHit && isDouble(dart)) doubleHit = true;
    if (doubleHit) effective += dart.score.points;
  }
  return effective;
}

// ============================================================
// Visit finalization
// ============================================================

function padWithMisses(darts: DartThrow[]): DartThrow[] {
  const MISS = { x: 0, y: 0, score: { label: 'miss' as const, points: 0, mult: 0, base: 0 } };
  return [
    ...darts,
    ...Array.from({ length: Math.max(0, MAX_DARTS - darts.length) }, () => ({ ...MISS, score: { ...MISS.score } })),
  ];
}

function commit(
  ctx: LegContext,
  darts: DartThrow[],
  playerId: string,
  voided: boolean,
  remainingAfter: number,
): FinalizedVisit {
  const won = !voided && remainingAfter === 0;
  const visit: Visit = {
    playerId,
    // A visit the player stopped throwing in keeps exactly the darts they threw: one cut short by a
    // bust, and the one that won the leg — nobody throws after checking out. Anything else is padded
    // out to full slots, because the turn cost three darts however few were aimed.
    darts: darts.length > 0 && (voided || won) ? darts : padWithMisses(darts),
    visitNumber: ctx.visits.length + 1,
    voided,
  };
  return { visit, legWinnerId: won ? playerId : null };
}

function finalizeNormal(ctx: LegContext, darts: DartThrow[], playerId: string, remainingBefore: number): FinalizedVisit {
  const remainingAfter = remainingBefore - pointsOf(darts);
  const { doubleOut } = read(ctx.settings);

  if (isBustScore(remainingAfter, doubleOut)) return commit(ctx, darts, playerId, true, remainingBefore);
  if (isNoDoubleCheckout(darts[darts.length - 1], doubleOut, remainingAfter)) {
    return commit(ctx, darts, playerId, true, remainingBefore);
  }
  return commit(ctx, darts, playerId, false, remainingAfter);
}

function finalizeDoubleIn(ctx: LegContext, darts: DartThrow[], playerId: string, remainingBefore: number): FinalizedVisit {
  const { doubleOut } = read(ctx.settings);

  // Everything from the first double onwards counts; anything before it scored nothing.
  let doubleHit = false;
  const validDarts: DartThrow[] = [];
  for (const dart of darts) {
    if (!doubleHit && !isDouble(dart)) continue;
    doubleHit = true;
    validDarts.push(dart);
  }

  if (!doubleHit) return commit(ctx, darts, playerId, true, remainingBefore);

  const remainingAfter = remainingBefore - pointsOf(validDarts);
  if (isBustScore(remainingAfter, doubleOut)) return commit(ctx, darts, playerId, true, remainingBefore);
  if (isNoDoubleCheckout(darts[darts.length - 1], doubleOut, remainingAfter)) {
    return commit(ctx, darts, playerId, true, remainingBefore);
  }
  return commit(ctx, validDarts, playerId, false, remainingAfter);
}

// ============================================================
// The mode
// ============================================================

/** Which of x01's two panel renderings to use, or neither. Development builds only — see `fields`. */
const STATS_FIELD: SettingsField = {
  key: 'stats',
  label: 'Statistics',
  kind: 'select',
  options: [
    { value: 'graphic', label: 'Graphic' },
    { value: 'text', label: 'Text' },
    { value: 'off', label: 'Off' },
  ],
};

export const x01: GameMode = {
  id: 'x01',
  label: 'x01',

  defaults: { startScore: 501, doubleIn: false, doubleOut: true, stats: 'graphic' },
  fields: [
    {
      key: 'startScore',
      label: 'Starting Score',
      kind: 'number',
      min: 101,
      max: 999,
      options: [
        { value: 301, label: '301' },
        { value: 501, label: '501' },
        { value: 701, label: '701' },
      ],
    },
    { key: 'doubleIn', label: 'Double In', kind: 'toggle' },
    { key: 'doubleOut', label: 'Double Out', kind: 'toggle' },
    // A knob for working on the panel, offered only in a development build. Left out of the field
    // list rather than hidden in the lobby, so the validator drops it too: in production `stats`
    // keeps its default and no crafted message can change it. The setting itself always exists —
    // production is simply always 'graphic'.
    ...(IS_DEV ? [STATS_FIELD] : []),
  ],

  dartsPerVisit(_settings: ModeSettings): number {
    return MAX_DARTS;
  },

  isVisitLocked(ctx: LegContext): boolean {
    const cv: CurrentVisit | undefined = ctx.currentVisit;
    if (!cv || cv.darts.length === 0) return false;
    if (cv.darts.length >= MAX_DARTS) return true;

    const remainingAfter = remainingFor(ctx, cv.playerId) - effectiveScore(ctx, cv.playerId, cv.darts);

    // Reaching zero ends the visit either way — won, or busted on a non-double.
    if (remainingAfter <= 0) return true;

    // A visit that has already busted has nothing left to throw for. Without this a double-out
    // player left on one would be invited to throw a third dart that cannot possibly help, and
    // would not be told they were out until the visit filled up.
    return isBustScore(remainingAfter, read(ctx.settings).doubleOut);
  },

  finalizeVisit(ctx: LegContext): FinalizedVisit {
    const playerId = ctx.currentVisit?.playerId ?? ctx.currentPlayerId;
    const darts = ctx.currentVisit?.darts ?? [];
    const remainingBefore = remainingFor(ctx, playerId);

    // Zero-dart submit: commit as a valid visit with 3 misses (not a bust).
    if (darts.length === 0) return commit(ctx, [], playerId, false, remainingBefore);

    return read(ctx.settings).doubleIn && !hasDoubledIn(ctx, playerId)
      ? finalizeDoubleIn(ctx, darts, playerId, remainingBefore)
      : finalizeNormal(ctx, darts, playerId, remainingBefore);
  },

  view(ctx: LegContext): ModeView {
    const { startScore, doubleOut } = read(ctx.settings);
    const cv = ctx.currentVisit;

    const playerScores: Record<string, ViewText> = {};
    for (const player of ctx.players) playerScores[player.id] = cardScore(ctx, player.id);

    return {
      headline: `${startScore} — ${doubleOut ? 'Double Out' : 'Straight Out'}`,
      notice: x01NeedsDoubleIn(ctx, ctx.currentPlayerId)
        ? 'Double-In required — hit a double to start scoring'
        : undefined,
      playerScores,
      // Always a number, so the line never disappears mid-visit.
      visitTotal: String(pointsOf(cv?.darts ?? [])),
      dartsPerVisit: MAX_DARTS,
      slots: (cv?.darts ?? []).map((dart) => ({
        text: `${dart.score.label}`,
        // A dart that scored nothing is worth seeing as such. That is x01's judgement, not the
        // screen's — a mode where a zero is unremarkable simply leaves the tone off.
        tone: dart.score.points > 0 ? ('positive' as const) : ('danger' as const),
      })),
      history: [...ctx.visits].reverse().map((visit) => describeVisit(ctx, visit)),
    };
  },

  /**
   * x01's statistics, over the whole match.
   *
   * The one place the mode is handed the match rather than a leg — because an average is about the
   * match, and reading it off a single leg would be a different number every time a leg ended.
   */
  panel(match: MatchState): ModePanel | undefined {
    // Off is not a hidden panel but no panel: undefined is already how a mode says it draws
    // nothing, so the statistics are not computed and `custom` never goes over the wire.
    const stats = stringOr(match.settings.modeSettings, 'stats', 'graphic');
    if (stats === 'off') return undefined;

    const visits = legsOf(match).flat();

    const byPlayer = (of: (own: Visit[]) => string) => {
      const values: Record<string, ViewText> = {};
      for (const player of match.players) values[player.id] = of(visits.filter((v) => v.playerId === player.id));
      return values;
    };

    // A finished match has no leg in progress, so what is happening in one is not worth reporting.
    const playing = match.status === 'in_progress';

    return {
      title: '',
      lines: playing ? [`Round ${roundNumber(match)}`] : undefined,
      // x01 ships a component, so `auto` draws the cards. Text asks for the plain table instead —
      // the same rows, without the bars a table cannot hold.
      render: stats === 'text' ? 'table' : 'auto',
      // For x01's own component, which draws what a table cannot. A deployment without that file
      // still gets the rows above, so nothing here is load-bearing.
      custom: { recent: recentScores(match), max: MAX_VISIT },
      rows: [
        ...(playing ? [{ label: 'Darts this leg', values: dartsThisLeg(match) }] : []),
        { label: '3-dart average', values: threeDartAverages(match) },
        { label: 'Scoring average', values: scoringAverages(match) },
        { label: '180s', values: byPlayer((own) => String(own.filter((v) => !v.voided && pointsOf(v.darts) === 180).length)) },
        { label: 'Best leg (darts)', values: bestLegDarts(match) },
        { label: 'Legs won', values: legsWon(match) },
      ],
    };
  },
};

// --- Statistics. Display only: nothing here is a rule. ---

/**
 * A player throwing at this or more is trying to score, not to finish: 170 is the highest checkout
 * there is, so below it the darts are aimed at a double rather than at a treble twenty.
 */
const SCORING_FLOOR = 170;

/** Three treble twenties. What a bar of recent scoring is measured against. */
const MAX_VISIT = 180;

/** How many recent visits the form bars show. */
const RECENT_VISITS = 6;

/** Every leg's visits, the one in progress last. */
function legsOf(match: MatchState): Visit[][] {
  return [...match.legs.map((leg) => leg.visits), match.visits];
}

/**
 * Which round the leg is in, counting from one.
 *
 * The visit about to be thrown counts, so a leg opens on round 1 before a dart is thrown, and the
 * number turns over when the player who started the leg comes back to the board.
 */
function roundNumber(match: MatchState): number {
  return Math.ceil((match.visits.length + 1) / Math.max(1, match.players.length));
}

/**
 * Darts thrown in the current leg.
 *
 * A submitted visit is three darts whatever happened in it — a visit cut short by a bust still cost
 * the player their turn, and counting it as one or two would flatter the average.
 */
function dartsThisLeg(match: MatchState): Record<string, ViewText> {
  const cv = match.currentVisit;
  return Object.fromEntries(match.players.map((player) => {
    const submitted = match.visits.filter((v) => v.playerId === player.id).length * MAX_DARTS;
    const inHand = cv?.playerId === player.id ? cv.darts.length : 0;
    return [player.id, String(submitted + inHand)];
  }));
}

/**
 * Scoring average: points per visit, counting only visits thrown from 170 or more.
 *
 * Below that a player is working out a finish rather than scoring, and visits spent setting up a
 * double say nothing about how hard they can score. Replayed leg by leg, because "what they were on"
 * is a question only the leg can answer.
 */
function scoringAverages(match: MatchState): Record<string, ViewText> {
  const startScore = read(match.settings.modeSettings).startScore;
  const scored: Record<string, number> = {};
  const counted: Record<string, number> = {};

  for (const visits of legsOf(match)) {
    const remaining: Record<string, number> = {};
    for (const visit of visits) {
      const before = remaining[visit.playerId] ?? startScore;
      const points = visit.voided ? 0 : pointsOf(visit.darts);
      if (before >= SCORING_FLOOR) {
        scored[visit.playerId] = (scored[visit.playerId] ?? 0) + points;
        counted[visit.playerId] = (counted[visit.playerId] ?? 0) + 1;
      }
      remaining[visit.playerId] = before - points;
    }
  }

  return Object.fromEntries(match.players.map((player) => {
    const visits = counted[player.id] ?? 0;
    return [player.id, visits === 0 ? '—' : ((scored[player.id] ?? 0) / visits).toFixed(1)];
  }));
}

/**
 * How many darts a player threw, out of these visits.
 *
 * Every visit costs three whatever was in it: one cut short by a bust still ended the turn, and a
 * player who submits early has still had their turn. The exception is **the visit that won the leg**
 * — the player stopped on the winning dart, so only the darts up to it were thrown, and counting
 * three there would flatter every leg and every average.
 */
function dartsThrownIn(visits: Visit[], playerId: string, legWinnerId: string | null): number {
  const own = visits.filter((visit) => visit.playerId === playerId);
  if (own.length === 0) return 0;

  const closing = playerId === legWinnerId ? own[own.length - 1].darts.length : MAX_DARTS;
  return (own.length - 1) * MAX_DARTS + closing;
}

/** Darts thrown across the whole match. A leg in progress has no winner, so nothing closes early. */
function dartsThrown(match: MatchState, playerId: string): number {
  const inLegs = match.legs.reduce((sum, leg) => sum + dartsThrownIn(leg.visits, playerId, leg.winnerId), 0);
  return inLegs + dartsThrownIn(match.visits, playerId, null);
}

/**
 * The three-dart average: what a player scores per three darts thrown.
 *
 * A void visit scores nothing but its darts were still thrown, so it counts against the average —
 * that is what makes one worth reading.
 */
function threeDartAverages(match: MatchState): Record<string, ViewText> {
  const visits = legsOf(match).flat();

  return Object.fromEntries(match.players.map((player) => {
    const darts = dartsThrown(match, player.id);
    if (darts === 0) return [player.id, '—'];

    const scored = visits
      .filter((visit) => visit.playerId === player.id && !visit.voided)
      .reduce((sum, visit) => sum + pointsOf(visit.darts), 0);
    return [player.id, ((scored / darts) * MAX_DARTS).toFixed(1)];
  }));
}

/** The fewest darts a player took to win a leg. Only won legs count; an unfinished one has no total. */
function bestLegDarts(match: MatchState): Record<string, ViewText> {
  const best: Record<string, number> = {};
  for (const leg of match.legs) {
    const darts = dartsThrownIn(leg.visits, leg.winnerId, leg.winnerId);
    const current = best[leg.winnerId];
    if (current === undefined || darts < current) best[leg.winnerId] = darts;
  }
  return Object.fromEntries(match.players.map((p) => [p.id, best[p.id] === undefined ? '—' : String(best[p.id])]));
}

/**
 * What each player has been scoring lately: their last few visits, oldest first.
 *
 * Numbers rather than text, because this is for x01's own component to draw as bars — a shape the
 * generic table has no way to express, and the reason x01 ships a second file at all.
 */
function recentScores(match: MatchState): Record<string, number[]> {
  const visits = legsOf(match).flat();
  return Object.fromEntries(match.players.map((player) => [
    player.id,
    visits
      .filter((visit) => visit.playerId === player.id)
      .slice(-RECENT_VISITS)
      .map((visit) => (visit.voided ? 0 : pointsOf(visit.darts))),
  ]));
}

function legsWon(match: MatchState): Record<string, ViewText> {
  const won: Record<string, number> = {};
  for (const leg of match.legs) won[leg.winnerId] = (won[leg.winnerId] ?? 0) + 1;
  return Object.fromEntries(match.players.map((p) => [p.id, String(won[p.id] ?? 0)]));
}

/**
 * What goes on a player's card.
 *
 * A visit the rules have already settled shows its verdict instead of a number: a player wants to
 * see "Bust!" the instant it happens, not a score that will be taken back when the visit is
 * submitted. The verdict carries its own tone and size, so the screen does not have to work out
 * that this string is not a score.
 */
function cardScore(ctx: LegContext, playerId: string): ViewText {
  const cv = ctx.currentVisit;
  if (cv && cv.playerId === playerId) {
    const verdict = verdictFor(ctx);
    if (verdict) return verdict;
  }

  let remaining = remainingFor(ctx, playerId);
  if (cv && cv.playerId === playerId) remaining -= effectiveScore(ctx, playerId, cv.darts);
  // A bare string: the card colours the player whose turn it is, and that is not x01's business.
  return String(Math.max(0, remaining));
}

/**
 * "Bust!" / "Checkout!" for a visit that is over, or null while it is still an ordinary score.
 *
 * Asks the rules what submitting would do rather than restating them: `finalizeVisit` is pure, so
 * running it speculatively costs nothing and cannot drift from the real outcome.
 */
function verdictFor(ctx: LegContext): StyledText | null {
  const cv = ctx.currentVisit;
  if (!cv || !cv.locked || cv.darts.length === 0) return null;

  const { visit, legWinnerId } = x01.finalizeVisit(ctx);
  if (visit.voided) return { text: 'Bust!', tone: 'danger', size: '3xl' };
  if (legWinnerId) return { text: 'Checkout!', tone: 'warning', size: '3xl' };
  return null;
}

function describeVisit(ctx: LegContext, visit: Visit): ViewText {
  const name = ctx.players.find((p) => p.id === visit.playerId)?.name ?? '?';
  const labels = visit.darts.map((d) => d.score.label).join(' ');
  const text = `${name}   ${labels} = ${visit.voided ? 'Bust' : pointsOf(visit.darts)}`;
  return visit.voided ? { text, tone: 'danger' } : text;
}

// --- x01's own helpers, for its view and its tests. Not part of the mode contract. ---

export function x01Remaining(ctx: LegContext, playerId: string): number {
  return remainingFor(ctx, playerId);
}

export function x01NeedsDoubleIn(ctx: LegContext, playerId: string): boolean {
  return read(ctx.settings).doubleIn && !hasDoubledIn(ctx, playerId);
}

registerMode(x01);
