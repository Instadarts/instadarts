import { describe, it, expect } from 'vitest';
import { sanitizeName, validateSettings, validateDartThrow, validateVisit } from '../../src/server/validation';
import { checkRateLimit, removeRateLimitBucket } from '../../src/server/rateLimit';
import { canCreateLobby, canCreateGame } from '../../src/server/concurrencyLimit';

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
  it('accepts valid settings', () => {
    const result = validateSettings({ startScore: 501, doubleIn: true, doubleOut: true });
    expect(result).toEqual({ startScore: 501, doubleIn: true, doubleOut: true });
  });

  it('accepts partial settings', () => {
    expect(validateSettings({ startScore: 301 })).toEqual({ startScore: 301 });
    expect(validateSettings({ doubleIn: false })).toEqual({ doubleIn: false });
    expect(validateSettings({ mode: 'x01' })).toEqual({ mode: 'x01' });
  });

  it('rejects non-objects', () => {
    expect(validateSettings(null)).toBeNull();
    expect(validateSettings(undefined)).toBeNull();
    expect(validateSettings('foo')).toBeNull();
    expect(validateSettings(123)).toBeNull();
    expect(validateSettings([])).toBeNull();
  });

  it('rejects empty objects', () => {
    expect(validateSettings({})).toBeNull();
  });

  it('clamps startScore to valid range', () => {
    expect(validateSettings({ startScore: 0 })).toBeNull();
    expect(validateSettings({ startScore: -1 })).toBeNull();
    expect(validateSettings({ startScore: 100 })).toBeNull();
    expect(validateSettings({ startScore: 1000 })).toBeNull();
    expect(validateSettings({ startScore: NaN })).toBeNull();
    expect(validateSettings({ startScore: Infinity })).toBeNull();
    expect(validateSettings({ startScore: 101 })).toEqual({ startScore: 101 });
    expect(validateSettings({ startScore: 999 })).toEqual({ startScore: 999 });
    expect(validateSettings({ startScore: 100.5 })).toBeNull(); // not integer
    // Number coercion: string '501' → 501, which is valid
    expect(validateSettings({ startScore: '501' })).toEqual({ startScore: 501 });
  });

  it('rejects unknown modes', () => {
    expect(validateSettings({ mode: 'x01' })).toEqual({ mode: 'x01' });
    expect(validateSettings({ mode: 'cricket' })).toBeNull();
    expect(validateSettings({ mode: '' })).toBeNull();
    expect(validateSettings({ mode: 123 })).toBeNull();
  });

  it('coerces booleans for doubleIn/doubleOut', () => {
    expect(validateSettings({ doubleIn: true })).toEqual({ doubleIn: true });
    expect(validateSettings({ doubleIn: false })).toEqual({ doubleIn: false });
    // Non-booleans get coerced by Boolean()
    expect(validateSettings({ doubleIn: 1 })).toEqual({ doubleIn: true });
    expect(validateSettings({ doubleOut: 0 })).toEqual({ doubleOut: false });
  });

  it('ignores unknown keys (no prototype pollution)', () => {
    const result = validateSettings({
      startScore: 501,
      __proto__: { isAdmin: true },
      constructor: 'evil',
      extraField: 'should be ignored',
    });
    expect(result).toEqual({ startScore: 501 });
    expect((result as any).extraField).toBeUndefined();
  });

  it('handles object with only unknown keys', () => {
    expect(validateSettings({ foo: 'bar', baz: 123 })).toBeNull();
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

describe('validateVisit', () => {
  const validDart = { x: 500_000, y: 726_000 }; // T20

  it('accepts valid visit with 1-3 darts', () => {
    expect(validateVisit({ playerId: 'p1', darts: [validDart] })).not.toBeNull();
    expect(validateVisit({ playerId: 'p1', darts: [validDart, validDart] })).not.toBeNull();
    expect(validateVisit({ playerId: 'p1', darts: [validDart, validDart, validDart] })).not.toBeNull();
  });

  it('rejects zero darts', () => {
    expect(validateVisit({ playerId: 'p1', darts: [] })).toBeNull();
  });

  it('rejects too many darts', () => {
    expect(validateVisit({ playerId: 'p1', darts: [validDart, validDart, validDart, validDart] })).toBeNull();
    expect(validateVisit({ playerId: 'p1', darts: Array(50).fill(validDart) })).toBeNull();
  });

  it('rejects missing or invalid playerId', () => {
    expect(validateVisit({ darts: [validDart] })).toBeNull();
    expect(validateVisit({ playerId: '', darts: [validDart] })).toBeNull();
    expect(validateVisit({ playerId: 123, darts: [validDart] })).toBeNull();
  });

  it('rejects non-array darts', () => {
    expect(validateVisit({ playerId: 'p1', darts: 'foo' })).toBeNull();
    expect(validateVisit({ playerId: 'p1', darts: null })).toBeNull();
    expect(validateVisit({ playerId: 'p1', darts: {} })).toBeNull();
  });

  it('rejects visit with any invalid darts', () => {
    expect(validateVisit({
      playerId: 'p1',
      darts: [validDart, { x: NaN, y: 500_000 }, validDart],
    })).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(validateVisit(null)).toBeNull();
    expect(validateVisit(undefined)).toBeNull();
    expect(validateVisit('foo')).toBeNull();
  });
});

// ============================================================
// Rate limiting
// ============================================================

describe('rate limiting', () => {
  it('allows initial burst of messages', () => {
    const id = 'test-ratelimit-1';
    // Should allow up to 10 messages
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(id)).toBe(true);
    }
    // 11th should be rejected
    expect(checkRateLimit(id)).toBe(false);
    removeRateLimitBucket(id);
  });

  it('different connections have independent limits', () => {
    const id1 = 'test-ratelimit-2a';
    const id2 = 'test-ratelimit-2b';

    for (let i = 0; i < 10; i++) {
      checkRateLimit(id1);
    }
    // id1 is exhausted, id2 should still work
    expect(checkRateLimit(id1)).toBe(false);
    expect(checkRateLimit(id2)).toBe(true);

    removeRateLimitBucket(id1);
    removeRateLimitBucket(id2);
  });
});

// ============================================================
// Concurrency limits
// ============================================================

describe('concurrency limits', () => {
  it('canCreateLobby and canCreateGame return booleans', () => {
    expect(typeof canCreateLobby()).toBe('boolean');
    expect(typeof canCreateGame()).toBe('boolean');
  });

  it('initially allows creation (store is empty)', () => {
    expect(canCreateLobby()).toBe(true);
    expect(canCreateGame()).toBe(true);
  });
});
