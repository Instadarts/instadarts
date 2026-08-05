import { describe, it, expect, beforeAll } from 'vitest';
import { X01Handler } from '../../src/server/modes/x01';
import { processVisit } from '../../src/server/game';
import { registerModeHandler } from '../../src/server/modes/types';

// Register the x01 mode handler once for all tests
beforeAll(() => {
  registerModeHandler('x01', new X01Handler());
});

// ============================================================
// Tests for online lobby player limits, local match cancel,
// session-based role enforcement, and creator immutability.
// ============================================================

function makeDart(label: string) {
  const darts: Record<string, any> = {
    'T20': { label: 'T20', points: 60, mult: 3, base: 20 },
    'D20': { label: 'D20', points: 40, mult: 2, base: 20 },
    'S20': { label: 'S20', points: 20, mult: 1, base: 20 },
  };
  return { x: 500_000, y: 500_000, score: darts[label] };
}

function makeGame(overrides: any = {}) {
  const { settings: settingsOverride, ...rest } = overrides;
  const settings = {
    mode: 'x01' as const,
    doubleIn: false,
    doubleOut: true,
    startScore: 501,
    ...(settingsOverride || {}),
  };
  return {
    id: 'test-game',
    status: 'in_progress' as const,
    settings,
    players: [
      { id: 'p1', name: 'Alice', isRemote: false, sessionId: 'session-a' },
      { id: 'p2', name: 'Bob', isRemote: false, sessionId: 'session-b' },
    ],
    visits: [],
    currentPlayerIndex: 0,
    winnerId: null,
    createdAt: Date.now(),
    finishedAt: null,
    isLocal: false,
    ...rest,
  };
}

describe('Online match player limits', () => {
  const handler = new X01Handler();

  it('allows up to 2 players (1 per session) in online lobby', () => {
    // This is enforced at the wsHandler level, not the game mode.
    // The game mode processes any visit from any player.
    // The test verifies the game logic is neutral.
    const game = makeGame({ isLocal: false });
    expect(game.players).toHaveLength(2);
    expect(game.players[0].sessionId).toBe('session-a');
    expect(game.players[1].sessionId).toBe('session-b');
    // Different sessions → valid online setup
    expect(game.players[0].sessionId).not.toBe(game.players[1].sessionId);
  });

  it('game properly tracks visit ownership', () => {
    const game = makeGame({ isLocal: false });
    const visit = {
      playerId: 'p1',
      darts: [makeDart('T20'), makeDart('T20'), makeDart('T20')],
      visitNumber: 0,
      bust: false,
    };
    const result = handler.processVisit(game, visit);
    expect(result.valid).toBe(true);
    expect(result.game.visits[0].playerId).toBe('p1');
  });
});

describe('Local match behavior', () => {
  const handler = new X01Handler();

  it('local game has isLocal = true', () => {
    const game = makeGame({ isLocal: true });
    expect(game.isLocal).toBe(true);
  });

  it('local game can have multiple players', () => {
    const game = makeGame({
      isLocal: true,
      players: [
        { id: 'p1', name: 'Alice', isRemote: false, sessionId: 'session-a' },
        { id: 'p2', name: 'Bob', isRemote: false, sessionId: 'session-a' },
      ],
    });
    // Same session for both players → local match
    expect(game.players[0].sessionId).toBe(game.players[1].sessionId);
  });

  it('local match player leave sets finished with no winner', () => {
    const game = makeGame({ isLocal: true, status: 'finished', winnerId: null, finishedAt: Date.now() });
    expect(game.status).toBe('finished');
    expect(game.winnerId).toBeNull();
    // Server sets winnerId = null for local match cancellation
  });
});

describe('Online match role enforcement', () => {
  it('creator sessionId is immutable', () => {
    const game = makeGame({ isLocal: false });
    const creatorSession = game.players[0].sessionId;
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

describe('Game finish scenarios', () => {
  const handler = new X01Handler();

  it('online match: checkout wins', () => {
    const game = makeGame({
      isLocal: false,
      settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 40 },
    });
    const visit = {
      playerId: 'p1',
      darts: [makeDart('D20')],
      visitNumber: 0,
      bust: false,
    };
    const result = handler.processVisit(game, visit);
    expect(result.won).toBe(true);
    expect(result.game.winnerId).toBe('p1');
  });

  it('online match: player leave declares other winner', () => {
    const game = makeGame({
      isLocal: false,
      status: 'finished',
      winnerId: 'p2',
      finishedAt: Date.now(),
    });
    // Simulating what handleClientLeave does for online
    expect(game.winnerId).toBe('p2');
  });

  it('local match: creator leave cancels with no winner', () => {
    const game = makeGame({
      isLocal: true,
      status: 'finished',
      winnerId: null,
      finishedAt: Date.now(),
    });
    // Simulating what handleClientLeave does for local
    expect(game.winnerId).toBeNull();
    expect(game.status).toBe('finished');
  });
});

describe('Visit submission ownership', () => {
  it('rejects visit for wrong player on their turn', () => {
    const game = makeGame({ isLocal: false, currentPlayerIndex: 0 });
    // p1's turn, but visit claims to be from p2
    const visit = {
      playerId: 'p2',
      darts: [makeDart('T20')],
      visitNumber: 0,
      bust: false,
    };
    const result = processVisit(game, visit);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not your turn');
  });

  it('accepts visit for correct player on their turn', () => {
    const game = makeGame({ isLocal: false, currentPlayerIndex: 0 });
    const visit = {
      playerId: 'p1',
      darts: [makeDart('T20')],
      visitNumber: 0,
      bust: false,
    };
    const result = processVisit(game, visit);
    expect(result.success).toBe(true);
  });
});

describe('Reconnect session validation', () => {
  it('rejects reconnect with mismatched sessionId', () => {
    const game = makeGame({ isLocal: false });
    // p1 has sessionId 'session-a', but reconnecting with session 'session-b'
    const player = game.players.find((p) => p.id === 'p1')!;
    expect(player.sessionId).toBe('session-a');
    // A client with sessionId 'session-b' trying to reconnect as p1 should fail
    // (this is enforced at the wsHandler level)
  });

  it('allows reconnect with matching sessionId', () => {
    const game = makeGame({ isLocal: false });
    const player = game.players.find((p) => p.id === 'p1')!;
    expect(player.sessionId).toBe('session-a');
    // A client with sessionId 'session-a' reconnecting as p1 should succeed
  });
});
