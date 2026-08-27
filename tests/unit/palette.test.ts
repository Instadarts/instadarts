import { describe, expect, it } from 'vitest';
import { appPalette } from '../../src/client/layout/palette';
import type { AppTokens } from '../../src/client/layout/palette';

/**
 * Surface separation is a number, not a judgement.
 *
 * Shades picked by eye on one monitor once left the dark scheme's page and its cards 5.3 apart in
 * L*, which reads as one flat wash — and nothing in the browser suite noticed, because every element
 * was exactly where it should be. These are the minimums docs/ui.md commits the palette to.
 *
 * Two measures, because they answer different questions. Whether two large blocks look like separate
 * surfaces is a question about perceived lightness, and L* is uniform enough to ask it with one
 * threshold for both schemes — a WCAG ratio is not, because the same ratio buys far less separation
 * near black than near white. Whether text can be read is a WCAG question, so text uses the ratio.
 */
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => channel(Number.parseInt(value.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** CIE lightness, 0 (black) to 100 (white). */
function lightness(hex: string): number {
  const y = luminance(hex);
  return 116 * (y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116) - 16;
}

/** How far apart two surfaces look. */
function separation(a: string, b: string): number {
  return Math.abs(lightness(a) - lightness(b));
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

type TokenPair = readonly [keyof AppTokens, keyof AppTokens, number];

/** A surface against the surface it sits on, in L*. */
const SURFACES: readonly TokenPair[] = [
  ['appBg', 'surface', 6],
  ['appBg', 'headerBg', 2],
  ['surface', 'surfaceRaised', 6],
  ['surface', 'surfaceSunken', 6],
  // The title bar is meant to be felt rather than seen; its border does the rest of the work.
  ['surface', 'surfaceHeader', 4],
  // A hairline is a thin shape, so it needs more than a block of the same colour would.
  ['surface', 'border', 12],
  ['surface', 'borderStrong', 20],
];

/** Text against the surface it is drawn on, as a WCAG ratio. */
const TEXT: readonly TokenPair[] = [
  ['surface', 'toneDefaultFg', 7],
  ['surfaceRaised', 'toneDefaultFg', 7],
  ['surfaceSunken', 'toneDefaultFg', 7],
  ['surface', 'toneMutedFg', 4.5],
  ['surfaceRaised', 'toneMutedFg', 4.5],
  // `--mantine-color-dimmed` resolves to this token, and `c="dimmed"` is used on every surface —
  // including the sunken one, which is the darkest ground it has to hold up on.
  ['surfaceSunken', 'toneMutedFg', 4.5],
  ['surface', 'accent', 3.5],
  ['surface', 'link', 3.5],
];

const TONES = ['Default', 'Muted', 'Accent', 'Positive', 'Warning', 'Danger', 'Info'] as const;

describe.each(['light', 'dark'] as const)('the %s palette', (scheme) => {
  const tokens = appPalette.tokens[scheme];

  it.each(SURFACES)('separates %s from %s by at least %f in L*', (a, b, minimum) => {
    expect(separation(tokens[a], tokens[b])).toBeGreaterThanOrEqual(minimum);
  });

  it.each(TEXT)('keeps %s and %s at least %f apart in contrast', (a, b, minimum) => {
    expect(contrast(tokens[a], tokens[b])).toBeGreaterThanOrEqual(minimum);
  });

  it.each(TONES)('keeps the %s tone readable on its own background', (tone) => {
    const foreground = tokens[`tone${tone}Fg` as keyof AppTokens];
    const background = tokens[`tone${tone}Bg` as keyof AppTokens];
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

it('gives every scale ten hex shades', () => {
  for (const [name, tuple] of Object.entries(appPalette.scales)) {
    expect(tuple, name).toHaveLength(10);
    for (const shade of tuple) expect(shade, name).toMatch(/^#[0-9a-f]{6}$/);
  }
});
