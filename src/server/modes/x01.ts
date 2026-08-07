import type { CurrentVisit, DartThrow, ModeSettings, ModeView, StyledText, ViewText, Visit } from '../../shared/types';
import type { FinalizedVisit, GameMode, LegContext } from './types';

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
    startScore: typeof settings.startScore === 'number' ? settings.startScore : 501,
    doubleIn: settings.doubleIn === true,
    doubleOut: settings.doubleOut !== false,
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
  const visit: Visit = {
    playerId,
    // A void visit keeps only what was thrown; anything that counted is padded out to full slots.
    darts: !voided || darts.length === 0 ? padWithMisses(darts) : darts,
    visitNumber: ctx.visits.length + 1,
    voided,
  };
  return { visit, legWinnerId: !voided && remainingAfter === 0 ? playerId : null };
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

export const x01: GameMode = {
  id: 'x01',

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
        text: `${dart.score.label} (${dart.score.points})`,
        // A dart that scored nothing is worth seeing as such. That is x01's judgement, not the
        // screen's — a mode where a zero is unremarkable simply leaves the tone off.
        tone: dart.score.points > 0 ? ('positive' as const) : ('danger' as const),
      })),
      history: [...ctx.visits].reverse().map((visit) => describeVisit(ctx, visit)),
    };
  },
};

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
