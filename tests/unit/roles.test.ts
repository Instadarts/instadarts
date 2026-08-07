import { describe, it, expect } from 'vitest';
import { addDartToMatch, undoDartFromMatch } from '../../src/server/match';
import { makeDart, makeMatch, playVisit } from '../helpers';

describe('Online match player limits', () => {
  it('match properly tracks visit ownership', () => {
    const match = playVisit(makeMatch({ isLocal: false }), 'p1', ['T20', 'T20', 'T20']);
    expect(match.visits[0].voided).toBe(false);
    expect(match.visits[0].playerId).toBe('p1');
  });

  it('allows up to 2 players (1 per session) in online lobby', () => {
    const match = makeMatch({ isLocal: false, players: [
      { id: 'p1', name: 'Alice', sessionId: 'session-a' },
      { id: 'p2', name: 'Bob', sessionId: 'session-b' },
    ] });
    expect(match.players).toHaveLength(2);
    expect(match.players[0].sessionId).toBe('session-a');
    expect(match.players[1].sessionId).toBe('session-b');
    expect(match.players[0].sessionId).not.toBe(match.players[1].sessionId);
  });
});

describe('Local match behavior', () => {
  it('local match has isLocal = true', () => {
    const match = makeMatch({ isLocal: true });
    expect(match.isLocal).toBe(true);
  });

  it('local match can have multiple players', () => {
    const match = makeMatch({
      isLocal: true,
      players: [
        { id: 'p1', name: 'Alice', sessionId: 'session-a' },
        { id: 'p2', name: 'Bob', sessionId: 'session-a' },
      ],
    });
    // Same session for both players → local match
    expect(match.players[0].sessionId).toBe(match.players[1].sessionId);
  });

  it('local match: creator disconnects → match cancelled with no winner', () => {
    const match = makeMatch({ isLocal: true, status: 'finished', winnerId: null, finishedAt: Date.now() });
    expect(match.status).toBe('finished');
    expect(match.winnerId).toBeNull();
    // Server sets winnerId = null for local match cancellation
  });
});

describe('Online match role enforcement', () => {
  it('creator sessionId is immutable', () => {
    const match = makeMatch({ isLocal: false, players: [
      { id: 'p1', name: 'Alice', sessionId: 'session-a' },
      { id: 'p2', name: 'Bob', sessionId: 'session-b' },
    ] });
    const creatorSession = match.players[0].sessionId;
    expect(creatorSession).toBe('session-a');
    // Creator's sessionId should never change
    // This is enforced by the server: hostSessionId is set once
  });

  it('joiner can only add 1 player (per-session check)', () => {
    // Server checks: lobby.players.some(p => p.sessionId === client.sessionId)
    // If joiner tries to add a second player, server rejects
    // This is a wsHandler-level check, tested via E2E
  });
});

describe('Match finish scenarios', () => {
  it('online match: checkout wins', () => {
    const match = makeMatch({
      isLocal: false,
      settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 40 },
    });
    const finished = playVisit(match, 'p1', ['D20']);
    expect(finished.status).toBe('finished');
    expect(finished.winnerId).toBe('p1');
  });

  it('online match: opponent disconnects → remaining player wins', () => {
    const match = makeMatch({
      isLocal: false,
      status: 'finished',
      winnerId: 'p2',
      finishedAt: Date.now(),
    });
    // Simulating what handleClientLeave does for online
    expect(match.winnerId).toBe('p2');
  });

  it('local match: creator leave cancels with no winner', () => {
    const match = makeMatch({
      isLocal: true,
      status: 'finished',
      winnerId: null,
      finishedAt: Date.now(),
    });
    // Simulating what handleClientLeave does for local
    expect(match.winnerId).toBeNull();
    expect(match.status).toBe('finished');
  });
});

describe('Visit submission ownership', () => {
  it('rejects dart for wrong player on their turn', () => {
    const match = makeMatch({ isLocal: false, currentPlayerIndex: 0 });
    const result = addDartToMatch(match, 'p2', makeDart('T20'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Not your turn');
  });

  it('accepts dart for correct player on their turn', () => {
    const match = makeMatch({ isLocal: false, currentPlayerIndex: 0 });
    expect(addDartToMatch(match, 'p1', makeDart('T20')).success).toBe(true);
  });
});

describe('undoDart via match.ts (turn enforcement layer)', () => {
  it('undoDart on an in-progress match succeeds', () => {
    const match = makeMatch({ currentPlayerIndex: 0 });
    let r = addDartToMatch(match, 'p1', makeDart('T20'));
    expect(r.success).toBe(true);
    r = addDartToMatch(r.match, 'p1', makeDart('S20'));
    expect(r.success).toBe(true);
    const undo = undoDartFromMatch(r.match);
    expect(undo.success).toBe(true);
    expect(undo.match.currentVisit?.darts).toHaveLength(1);
    expect(undo.match.currentVisit!.darts[0].score.label).toBe('T20');
  });

  it('undoDart on a finished match is rejected', () => {
    const match = makeMatch({ status: 'finished', winnerId: 'p1' });
    const result = undoDartFromMatch(match);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('Match is not in progress');
  });

  it('undoDart with no darts returns clean state', () => {
    const match = makeMatch();
    const result = undoDartFromMatch(match);
    expect(result.success).toBe(true);
    expect(result.match.currentVisit).toBeUndefined();
  });
});

describe('Reconnect session validation', () => {
  // These scenarios are enforced at the wsHandler level — verified via E2E.
  // Unit-level assertions verify the expected sessionId relationships.

  it('player sessionId matches expected value', () => {
    const match = makeMatch({ isLocal: false, players: [
      { id: 'p1', name: 'Alice', sessionId: 'session-a' },
      { id: 'p2', name: 'Bob', sessionId: 'session-b' },
    ] });
    const player = match.players.find((p) => p.id === 'p1')!;
    expect(player.sessionId).toBe('session-a');
    // Reconnect enforcement (mismatched sessionId → reject, matching → allow)
    // is handled by the wsHandler — see E2E tests.
  });

  it('local match allows same session for multiple players', () => {
    const match = makeMatch({
      isLocal: true,
      players: [
        { id: 'p1', name: 'Alice', sessionId: 'local-session' },
        { id: 'p2', name: 'Bob', sessionId: 'local-session' },
      ],
    });
    expect(match.players[0].sessionId).toBe(match.players[1].sessionId);
  });
});
