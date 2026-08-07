import { describe, it, expect } from 'vitest';
import { sanitizeName, validateSettings, validateDartThrow } from '../../src/server/validation';
import type { MatchSettings } from '../../src/shared/types';
import { checkRateLimit, removeRateLimitBucket } from '../../src/server/rateLimit';
import { canCreateLobby, canCreateMatch } from '../../src/server/concurrencyLimit';

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
  const current: MatchSettings = { mode: 'x01', modeSettings: { startScore: 501, doubleIn: false, doubleOut: true } };
  const settings = (modeSettings: Record<string, unknown>, mode = 'x01') => ({ mode, modeSettings });

  it('accepts valid settings', () => {
    expect(validateSettings(settings({ startScore: 301, doubleIn: true, doubleOut: true }), current)).toEqual({
      mode: 'x01',
      modeSettings: { startScore: 301, doubleIn: true, doubleOut: true },
    });
  });

  it('fills the gaps from the current settings', () => {
    expect(validateSettings(settings({ startScore: 301 }), current)).toEqual({
      mode: 'x01',
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

  it('ignores undeclared keys (no prototype pollution)', () => {
    const result = validateSettings(
      settings({ startScore: 301, __proto__: { isAdmin: true }, constructor: 'evil', extraField: 'ignored' }),
      current,
    );
    expect(result).toEqual({ mode: 'x01', modeSettings: { startScore: 301, doubleIn: false, doubleOut: true } });
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
  it('canCreateLobby and canCreateMatch return booleans', () => {
    expect(typeof canCreateLobby()).toBe('boolean');
    expect(typeof canCreateMatch()).toBe('boolean');
  });

  it('initially allows creation (store is empty)', () => {
    expect(canCreateLobby()).toBe(true);
    expect(canCreateMatch()).toBe(true);
  });
});
