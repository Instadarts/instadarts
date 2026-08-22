import type { FinalizedVisit, GameMode, LegContext } from './types';
import { registerMode } from './types';
import type { DartThrow, ModePanel, ModeView, PlayerScoreText, ViewText, Visit } from '../../shared/types';
import type { ModeSettings } from '../../shared/settings';
import { numberOr } from '../../shared/settings';
import { IS_DEV } from '../env';

const MAX_DARTS = 3;

interface CountUpSettings {
  targetScore: number;
}

function read(settings: ModeSettings): CountUpSettings {
  return {
    targetScore: numberOr(settings, 'targetScore', 200),
  };
}

function pointsOf(darts: DartThrow[]): number {
  return darts.reduce((sum, d) => sum + d.score.points, 0);
}

function scoreFor(ctx: LegContext, playerId: string): number {
  let score = 0;
  for (const visit of ctx.visits) {
    if (visit.playerId === playerId && !visit.voided) {
      score += pointsOf(visit.darts);
    }
  }
  return score;
}

function liveScoreFor(ctx: LegContext, playerId: string): number {
  let score = scoreFor(ctx, playerId);
  if (ctx.currentVisit && ctx.currentVisit.playerId === playerId) {
    score += pointsOf(ctx.currentVisit.darts);
  }
  return score;
}

function padWithMisses(darts: DartThrow[]): DartThrow[] {
  const MISS = { x: 0, y: 0, score: { label: 'miss' as const, points: 0, mult: 0, base: 0 } };
  return [
    ...darts,
    ...Array.from({ length: Math.max(0, MAX_DARTS - darts.length) }, () => ({ ...MISS, score: { ...MISS.score } })),
  ];
}

export const countUp: GameMode = {
  id: 'count-up',
  label: 'Count-Up',

  defaults: { targetScore: 200 },
  fields: [
    {
      key: 'targetScore',
      label: 'Target Score',
      kind: 'number',
      min: 50,
      max: 1000,
      options: [
        { value: 100, label: '100' },
        { value: 200, label: '200' },
        { value: 300, label: '300' },
        { value: 500, label: '500' },
      ],
    },
  ],

  dartsPerVisit(_settings: ModeSettings): number {
    return MAX_DARTS;
  },

  isVisitLocked(ctx: LegContext): boolean {
    const cv = ctx.currentVisit;
    if (!cv || cv.darts.length === 0) return false;
    if (cv.darts.length >= MAX_DARTS) return true;
    const { targetScore } = read(ctx.settings);
    return liveScoreFor(ctx, cv.playerId) >= targetScore;
  },

  finalizeVisit(ctx: LegContext): FinalizedVisit {
    const playerId = ctx.currentVisit?.playerId ?? ctx.currentPlayerId;
    const rawDarts = ctx.currentVisit?.darts ?? [];
    const { targetScore } = read(ctx.settings);
    const scoreBefore = scoreFor(ctx, playerId);
    const totalScore = scoreBefore + pointsOf(rawDarts);
    const won = totalScore >= targetScore;

    const darts = rawDarts.length > 0 && won ? rawDarts : padWithMisses(rawDarts);
    const visit: Visit = {
      playerId,
      darts,
      visitNumber: ctx.visits.length + 1,
      voided: false,
    };

    return { visit, legWinnerId: won ? playerId : null };
  },

  view(ctx: LegContext): ModeView {
    const { targetScore } = read(ctx.settings);
    const cv = ctx.currentVisit;

    const playerScores: Record<string, PlayerScoreText> = {};
    for (const player of ctx.players) {
      playerScores[player.id] = String(liveScoreFor(ctx, player.id));
    }

    return {
      headline: `Count-Up — First to ${targetScore}`,
      playerScores,
      visitTotal: String(pointsOf(cv?.darts ?? [])),
      dartsPerVisit: MAX_DARTS,
      slots: (cv?.darts ?? []).map((dart) => ({
        text: dart.score.label,
        tone: dart.score.points > 0 ? ('positive' as const) : ('default' as const),
      })),
      history: [...ctx.visits].reverse().map((visit) => {
        const name = ctx.players.find((p) => p.id === visit.playerId)?.name ?? '?';
        const labels = visit.darts.map((d) => d.score.label).join(' ');
        return `${name}   ${labels} = ${pointsOf(visit.darts)}`;
      }),
    };
  },

  panel(match): ModePanel | undefined {
    const values: Record<string, ViewText> = {};
    for (const player of match.players) {
      const totalPoints = match.visits
        .filter((v) => v.playerId === player.id && !v.voided)
        .reduce((sum, v) => sum + pointsOf(v.darts), 0);
      values[player.id] = String(totalPoints);
    }

    return {
      title: 'Count-Up',
      render: 'auto',
      rows: [
        { label: 'Score', values },
      ],
    };
  },
};

if (IS_DEV) {
  registerMode(countUp);
}
