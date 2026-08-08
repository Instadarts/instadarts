import { describe, it, expect } from 'vitest';
import { viewOf } from '../../src/server/match';
import { styleOf, textOf } from '../../src/shared/types';
import { makeMatch, playVisit, throwDart } from '../helpers';

/**
 * What the match screen is handed. These strings are the whole contract between x01 and the screen:
 * the screen knows no rule, so anything it displays has to be right here.
 */
describe('x01 view', () => {
  it('describes the match in the headline', () => {
    expect(viewOf(makeMatch()).headline).toBe('501 — Double Out');
    expect(viewOf(makeMatch({ settings: { startScore: 301, doubleOut: false } })).headline).toBe('301 — Straight Out');
  });

  it('reports each player card as text', () => {
    const match = playVisit(makeMatch(), 'p1', ['T20', 'T20', 'T20']);
    const { playerScores } = viewOf(match);
    expect(textOf(playerScores.p1)).toBe('321');
    expect(textOf(playerScores.p2)).toBe('501');
    // An ordinary score carries no hints: the card colours whoever is throwing, and that is not
    // x01's business.
    expect(playerScores.p1).toBe('321');
  });

  it('counts the visit in progress down live', () => {
    const r = throwDart(makeMatch(), 'p1', 'T20');
    const view = viewOf(r.match);
    expect(textOf(view.playerScores.p1)).toBe('441');
    expect(textOf(view.visitTotal)).toBe('60');
  });

  it('replaces the score with a verdict once the visit is settled', () => {
    // Bust: 60 thrown into 40 remaining. The mode says it is bad news; the screen does not have to
    // work out that this string is not a score.
    const bust = throwDart(makeMatch({ settings: { startScore: 40 } }), 'p1', 'T20');
    const busted = viewOf(bust.match).playerScores.p1;
    expect(textOf(busted)).toBe('Bust!');
    expect(styleOf(busted)).toMatchObject({ tone: 'danger', size: '3xl' });

    // Checkout: D16 from 32.
    const out = throwDart(makeMatch({ settings: { startScore: 32 } }), 'p1', 'D16');
    const won = viewOf(out.match).playerScores.p1;
    expect(textOf(won)).toBe('Checkout!');
    expect(styleOf(won)).toMatchObject({ tone: 'warning' });
  });

  it('keeps the visit total visible before the first dart', () => {
    // Empty text would hide the line; x01 wants it there from the start.
    expect(textOf(viewOf(makeMatch()).visitTotal)).toBe('0');
  });

  it('shows the double-in prompt only while it is owed', () => {
    const match = makeMatch({ settings: { doubleIn: true } });
    expect(viewOf(match).notice).toContain('Double-In required');

    const after = playVisit(match, 'p1', ['D20']);
    expect(viewOf(playVisit(after, 'p2', [])).notice).toBeUndefined();
  });

  it('renders history newest first, with the thrower and the outcome', () => {
    let match = playVisit(makeMatch({ settings: { startScore: 100 } }), 'p1', ['T20', 'S20']);
    match = playVisit(match, 'p2', ['T20', 'T20', 'T20']);

    const history = viewOf(match).history;
    expect(history).toHaveLength(2);
    expect(textOf(history[0])).toContain('Bob');   // newest first
    expect(textOf(history[1])).toContain('Alice');
    expect(textOf(history[1])).toContain('T20 S20 miss = 80');
  });

  it('marks a voided visit in the history, in words and in tone', () => {
    const voided = playVisit(makeMatch({ settings: { startScore: 40 } }), 'p1', ['T20']);
    expect(textOf(viewOf(voided).history[0])).toContain('= Bust');
    expect(styleOf(viewOf(voided).history[0])).toMatchObject({ tone: 'danger' });

    // A visit that counted says nothing about how it should look.
    const scored = playVisit(makeMatch(), 'p1', ['T20']);
    expect(styleOf(viewOf(scored).history[0])).toEqual({});
  });

  it('reports the slot count, and tones the slots it fills', () => {
    expect(viewOf(makeMatch()).dartsPerVisit).toBe(3);

    let r = throwDart(makeMatch(), 'p1', 'T20');
    r = throwDart(r.match, 'p1', 'miss');
    const slots = viewOf(r.match).slots!;
    // A slot says what was hit. What it was worth is the visit total's job, not three labels'.
    expect(slots.map(textOf)).toEqual(['T20', 'miss']);
    expect(styleOf(slots[0])).toMatchObject({ tone: 'positive' });
    expect(styleOf(slots[1])).toMatchObject({ tone: 'danger' });
  });

  it('offers no panel — x01 has nothing of its own to draw', () => {
    expect(viewOf(makeMatch()).panel).toBeUndefined();
  });
});
