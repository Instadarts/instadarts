import { describe, it, expect, vi } from 'vitest';
import '../helpers'; // installs the x01 game mode
import { sanitizeName, validateSettings, validateDartThrow } from '../../src/server/validation';
import type { MatchSettings } from '../../src/shared/types';
import { checkRateLimit, releaseRateLimit } from '../../src/server/rateLimit';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import type { WebSocket } from 'ws';
import { canCreateLobby, canCreateMatch } from '../../src/server/capacity';

// ============================================================
// Player name sanitization
// ============================================================

describe('sanitizeName', () => {
  it('accepts valid names', () => {
    expect(sanitizeName('Alice')).toBe('Alice');
    expect(sanitizeName('  Bob  ')).toBe('Bob');
    expect(sanitizeName('a')).toBe('a');
    expect(sanitizeName('x'.repeat(20))).toBe('x'.repeat(20));
    expect(sanitizeName('Player 1')).toBe('Player 1');
    expect(sanitizeName('José')).toBe('José');
  });

  it('rejects non-strings', () => {
    expect(sanitizeName(null)).toBeNull();
    expect(sanitizeName(undefined)).toBeNull();
    expect(sanitizeName(123)).toBeNull();
    expect(sanitizeName({})).toBeNull();
    expect(sanitizeName([])).toBeNull();
    expect(sanitizeName(true)).toBeNull();
  });

  it('rejects empty or whitespace-only', () => {
    expect(sanitizeName('')).toBeNull();
    expect(sanitizeName('   ')).toBeNull();
    expect(sanitizeName('\t\n')).toBeNull();
  });

  it('rejects too short or too long', () => {
    expect(sanitizeName('')).toBeNull();
    expect(sanitizeName('x'.repeat(21))).toBeNull();
    expect(sanitizeName('x'.repeat(100))).toBeNull();
  });

  it('strips control characters', () => {
    expect(sanitizeName('Al\0ice')).toBe('Alice');
    expect(sanitizeName('Bob\x1f')).toBe('Bob');
    expect(sanitizeName('\x7fTest')).toBe('Test');
    expect(sanitizeName('A\x00\x01\x02B')).toBe('AB');
  });

  it('rejects if only control chars remain after strip', () => {
    expect(sanitizeName('\x00\x01')).toBeNull();
  });

  it('handles unicode tricks', () => {
    // Zero-width spaces stripped? They're not control chars in the ASCII range
    // but shouldn't matter since length 1-20 works
    expect(sanitizeName('A\u200B')).toBe('A\u200B');
    // Emoji are fine
    expect(sanitizeName('🎯')).toBe('🎯');
  });
});

// ============================================================
// Settings validation
// ============================================================

describe('validateSettings', () => {
  // Settings are validated against what the mode declares in shared/modes/catalog.ts, so nothing
  // here — and nothing in validation.ts — names an x01 setting except the fixtures.
  const current: MatchSettings = {
    mode: 'x01',
    modeSettings: { startScore: 501, doubleIn: false, doubleOut: true },
    setsToWinMatch: 1,
    legsToWinSet: 1,
  };
  const settings = (modeSettings: Record<string, unknown>, mode = 'x01') => ({ mode, modeSettings });

  it('accepts valid settings', () => {
    expect(validateSettings(settings({ startScore: 301, doubleIn: true, doubleOut: true }), current)).toEqual({
      ...current,
      modeSettings: { startScore: 301, doubleIn: true, doubleOut: true },
    });
  });

  it('validates the match format the same way as a mode setting', () => {
    const format = (over: Record<string, unknown>) => validateSettings({ ...over }, current)!;

    expect(format({ setsToWinMatch: 3, legsToWinSet: 5 })).toMatchObject({ setsToWinMatch: 3, legsToWinSet: 5 });
    // A minimum of one of each, declared by the field and enforced by the same code as any other.
    expect(format({ legsToWinSet: 0 }).legsToWinSet).toBe(1);
    expect(format({ legsToWinSet: -3 }).legsToWinSet).toBe(1);
    expect(format({ setsToWinMatch: 0 }).setsToWinMatch).toBe(1);
    expect(format({ setsToWinMatch: 1.5 }).setsToWinMatch).toBe(1);
    expect(format({ setsToWinMatch: 999 }).setsToWinMatch).toBe(1); // above the cap, so dropped
    expect(format({ setsToWinMatch: '3' }).setsToWinMatch).toBe(3); // coerced, then checked
  });

  it('fills the gaps from the current settings', () => {
    expect(validateSettings(settings({ startScore: 301 }), current)).toEqual({
      ...current,
      modeSettings: { startScore: 301, doubleIn: false, doubleOut: true },
    });
    expect(validateSettings(settings({}), current)).toEqual(current);
    expect(validateSettings({ mode: 'x01' }, current)).toEqual(current);
  });

  it('rejects non-objects', () => {
    expect(validateSettings(null, current)).toBeNull();
    expect(validateSettings(undefined, current)).toBeNull();
    expect(validateSettings('foo', current)).toBeNull();
    expect(validateSettings(123, current)).toBeNull();
    expect(validateSettings([], current)).toBeNull();
  });

  it('keeps an empty payload as the current settings', () => {
    // Nothing to apply is not an error; only a malformed payload or an unknown mode is.
    expect(validateSettings({}, current)).toEqual(current);
  });

  it('holds a number field to its declared range', () => {
    const startScore = (value: unknown) =>
      validateSettings(settings({ startScore: value }), current)!.modeSettings.startScore;

    expect(startScore(101)).toBe(101);
    expect(startScore(999)).toBe(999);
    expect(startScore('501')).toBe(501); // coerced, then checked
    // Out of range or not an integer → the field is dropped and the current value kept.
    expect(startScore(0)).toBe(501);
    expect(startScore(-1)).toBe(501);
    expect(startScore(100)).toBe(501);
    expect(startScore(1000)).toBe(501);
    expect(startScore(NaN)).toBe(501);
    expect(startScore(Infinity)).toBe(501);
    expect(startScore(100.5)).toBe(501);
  });

  it('rejects unknown modes', () => {
    expect(validateSettings({ mode: 'cricket' }, current)).toBeNull();
    expect(validateSettings({ mode: '' }, current)).toBeNull();
    expect(validateSettings({ mode: 123 }, current)).toEqual(current); // not a string → mode unchanged
  });

  it('coerces toggle fields', () => {
    const doubleIn = (value: unknown) =>
      validateSettings(settings({ doubleIn: value }), current)!.modeSettings.doubleIn;

    expect(doubleIn(true)).toBe(true);
    expect(doubleIn(false)).toBe(false);
    expect(doubleIn(1)).toBe(true);
    expect(doubleIn(0)).toBe(false);
  });

  it('holds a select field to its declared options', () => {
    const stats = (value: unknown) =>
      validateSettings(settings({ stats: value }), current)!.modeSettings.stats;

    expect(stats('text')).toBe('text');
    expect(stats('off')).toBe('off');
    // A select is a closed list, so anything else leaves the current value standing rather than
    // putting the mode into a state it never declared.
    expect(stats('sideways')).toBeUndefined();   // nothing current to keep, in this fixture
    expect(stats(1)).toBeUndefined();
    expect(stats(null)).toBeUndefined();
  });

  it('ignores undeclared keys (no prototype pollution)', () => {
    const result = validateSettings(
      settings({ startScore: 301, __proto__: { isAdmin: true }, constructor: 'evil', extraField: 'ignored' }),
      current,
    );
    expect(result).toEqual({ ...current, modeSettings: { startScore: 301, doubleIn: false, doubleOut: true } });
    expect((result!.modeSettings as any).extraField).toBeUndefined();
  });

  it('keeps the current settings when only undeclared keys are sent', () => {
    expect(validateSettings(settings({ foo: 'bar', baz: 123 }), current)).toEqual(current);
  });
});

// ============================================================
// Dart throw validation
// ============================================================

describe('validateDartThrow', () => {
  it('accepts valid coordinates', () => {
    const result = validateDartThrow({ x: 500_000, y: 500_000 });
    expect(result).not.toBeNull();
    expect(result!.x).toBe(500_000);
    expect(result!.y).toBe(500_000);
    expect(result!.score.label).toBe('DB');
    expect(result!.score.points).toBe(50);
  });

  it('recomputes score from coordinates (ignores client-supplied scores)', () => {
    // Client claims T20 from the bullseye
    const result = validateDartThrow({
      x: 500_000,
      y: 500_000,
      score: { label: 'T20', points: 60, mult: 3, base: 20 },
    });
    expect(result).not.toBeNull();
    expect(result!.score.label).toBe('DB');  // re-computed, not T20
    expect(result!.score.points).toBe(50);
  });

  it('accepts edge coordinates', () => {
    expect(validateDartThrow({ x: 0, y: 0 })).not.toBeNull();
    expect(validateDartThrow({ x: 1_000_000, y: 1_000_000 })).not.toBeNull();
    expect(validateDartThrow({ x: 0, y: 1_000_000 })).not.toBeNull();
  });

  it('rejects out-of-range coordinates', () => {
    expect(validateDartThrow({ x: -1, y: 500_000 })).toBeNull();
    expect(validateDartThrow({ x: 500_000, y: -1 })).toBeNull();
    expect(validateDartThrow({ x: 1_000_001, y: 500_000 })).toBeNull();
    expect(validateDartThrow({ x: 500_000, y: 1_000_001 })).toBeNull();
    expect(validateDartThrow({ x: -999999, y: -999999 })).toBeNull();
  });

  it('rejects non-finite coordinates', () => {
    expect(validateDartThrow({ x: NaN, y: 500_000 })).toBeNull();
    expect(validateDartThrow({ x: 500_000, y: Infinity })).toBeNull();
    expect(validateDartThrow({ x: -Infinity, y: 500_000 })).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(validateDartThrow(null)).toBeNull();
    expect(validateDartThrow(undefined)).toBeNull();
    expect(validateDartThrow('foo')).toBeNull();
    expect(validateDartThrow(123)).toBeNull();
    expect(validateDartThrow([])).toBeNull();
  });

  it('rejects missing coordinates', () => {
    expect(validateDartThrow({ x: 500_000 })).toBeNull();
    expect(validateDartThrow({ y: 500_000 })).toBeNull();
    expect(validateDartThrow({})).toBeNull();
  });

  it('accepts string coordinates (Number coercion)', () => {
    expect(validateDartThrow({ x: '500000', y: 500_000 })).not.toBeNull();
    expect(validateDartThrow({ x: 500_000, y: '500000' })).not.toBeNull();
  });
});

// ============================================================
// Visit validation
// ============================================================

// ============================================================
// Rate limiting
// ============================================================

describe('rate limiting', () => {
  it('lets a burst no honest client could produce through untouched', () => {
    const id = 'test-ratelimit-1';
    // Measured by logging every inbound message through a full end-to-end run: a page arriving in a
    // room sends four of its own accord, and the busiest second anywhere in the suite was twelve —
    // a test doing in under a second what a person does over half a minute in a lobby. Thirty is
    // past anything a person or the interface produces, and it is still only half the allowance.
    for (let i = 0; i < 30; i++) expect(checkRateLimit(id)).toBe(true);
    releaseRateLimit(id, null);
  });

  it('bounds a flood at the sustained rate rather than at the burst', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const id = 'test-ratelimit-flood';

      // A client that never pauses gets the burst once, and nothing else while the clock stands
      // still. The burst is an allowance for being quiet, not a rate.
      let allowed = 0;
      for (let i = 0; i < 500; i++) if (checkRateLimit(id)) allowed += 1;
      expect(allowed).toBe(60);
      expect(checkRateLimit(id)).toBe(false);

      // A second later it has earned one second of refill — ten — and not another whole burst.
      vi.advanceTimersByTime(1000);
      allowed = 0;
      for (let i = 0; i < 500; i++) if (checkRateLimit(id)) allowed += 1;
      expect(allowed).toBe(10);

      releaseRateLimit(id, null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refills the whole allowance back for a client that goes quiet', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const id = 'test-ratelimit-quiet';
      for (let i = 0; i < 500 && checkRateLimit(id); i += 1) { /* spend it */ }

      vi.advanceTimersByTime(30_000);
      let allowed = 0;
      for (let i = 0; i < 500; i++) if (checkRateLimit(id)) allowed += 1;
      expect(allowed).toBe(60);

      releaseRateLimit(id, null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a connection that empties its budget instead of dropping the message', () => {
    const sessionId = 'test-ratelimit-close';
    const closed: { code: number; reason: string }[] = [];
    const ws = {
      readyState: 1,
      OPEN: 1,
      send: () => {},
      close: (code: number, reason: string) => closed.push({ code, reason }),
    } as unknown as WebSocket;
    registerClient(ws, {
      sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null,
    });

    try {
      // `start_match` from a connection holding no seat: the cheapest message that reaches the
      // budget and then does nothing at all.
      let sent = 0;
      while (closed.length === 0 && sent < 500) {
        handleMessage(ws, JSON.stringify({ type: 'start_match' }));
        sent += 1;
      }

      // Dropping one message and carrying on is the worst of both: an honest client is left quietly
      // diverged from the server, and a flood is not slowed down at all. 1013 is "try again later",
      // which the client's own reconnect already treats as a reason to come back.
      expect(closed).toEqual([{ code: 1013, reason: 'Rate limit exceeded' }]);
      // And it took a real burst to get there, not ten.
      expect(sent).toBeGreaterThan(30);
    } finally {
      removeClient(ws);
      releaseRateLimit(sessionId, null);
    }
  });

  it('different connections have independent limits', () => {
    const id1 = 'test-ratelimit-2a';
    const id2 = 'test-ratelimit-2b';

    for (let i = 0; i < 500 && checkRateLimit(id1); i += 1) { /* exhaust id1 */ }
    expect(checkRateLimit(id1)).toBe(false);
    expect(checkRateLimit(id2)).toBe(true);

    releaseRateLimit(id1, null);
    releaseRateLimit(id2, null);
  });
});

// ============================================================
// Concurrency limits
// ============================================================

describe('concurrency limits', () => {
  it('canCreateLobby and canCreateMatch return booleans', () => {
    expect(typeof canCreateLobby()).toBe('boolean');
    expect(typeof canCreateMatch()).toBe('boolean');
  });

  it('initially allows creation (store is empty)', () => {
    expect(canCreateLobby()).toBe(true);
    expect(canCreateMatch()).toBe(true);
  });
});
