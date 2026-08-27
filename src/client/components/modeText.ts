import { toneOf } from '../../shared/types';
import type { TextTone, ViewText } from '../../shared/types';
import type { CSSProperties } from 'react';

type TextSize = 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl';
type TextWeight = 'normal' | 'medium' | 'semibold' | 'bold';

interface TextPresentation {
  tone?: TextTone;
  size?: TextSize;
  weight?: TextWeight;
}

// A tone is what the server said about a value, not a colour it asked for. Both tables therefore
// name palette tokens: the six tones have to keep meaning the same thing in either colour scheme,
// and no single shade number is right on both charcoal and paper. See layout/palette.ts.
const TONE_TEXT: Record<TextTone, string> = {
  default: 'var(--instadarts-tone-default-fg)',
  muted: 'var(--instadarts-tone-muted-fg)',
  accent: 'var(--instadarts-tone-accent-fg)',
  positive: 'var(--instadarts-tone-positive-fg)',
  warning: 'var(--instadarts-tone-warning-fg)',
  danger: 'var(--instadarts-tone-danger-fg)',
};

const TONE_SLOT: Record<TextTone, { color: string; background: string }> = {
  default: { color: 'var(--instadarts-tone-default-fg)', background: 'var(--instadarts-tone-default-bg)' },
  muted: { color: 'var(--instadarts-tone-muted-fg)', background: 'var(--instadarts-tone-muted-bg)' },
  accent: { color: 'var(--instadarts-tone-accent-fg)', background: 'var(--instadarts-tone-accent-bg)' },
  positive: { color: 'var(--instadarts-tone-positive-fg)', background: 'var(--instadarts-tone-positive-bg)' },
  warning: { color: 'var(--instadarts-tone-warning-fg)', background: 'var(--instadarts-tone-warning-bg)' },
  danger: { color: 'var(--instadarts-tone-danger-fg)', background: 'var(--instadarts-tone-danger-bg)' },
};

const WEIGHT = { normal: 400, medium: 500, semibold: 600, bold: 700 } as const;
const SIZE: Record<TextSize, string> = {
  xs: '0.75rem',
  sm: '0.875rem',
  base: '1rem',
  lg: '1.125rem',
  xl: '1.25rem',
  '2xl': '1.5rem',
  '3xl': '1.875rem',
  '4xl': '2.25rem',
  '5xl': '3.0rem',
};

export interface ModeTextProps {
  c: string;
  fz: string;
  fw: number;
}

export function modeTextProps(value: ViewText | undefined, presentation: TextPresentation = {}): ModeTextProps {
  return {
    c: TONE_TEXT[toneOf(value) ?? presentation.tone ?? 'default'],
    fz: SIZE[presentation.size ?? 'base'],
    fw: WEIGHT[presentation.weight ?? 'normal'],
  };
}

export function slotStyle(value: ViewText | undefined, presentation: TextPresentation = {}): CSSProperties {
  const toneName = toneOf(value) ?? presentation.tone ?? 'default';
  const tone = TONE_SLOT[toneName];
  return {
    color: tone.color,
    backgroundColor: tone.background,
    fontSize: SIZE[presentation.size ?? 'base'],
    fontWeight: WEIGHT[presentation.weight ?? 'normal'],
  };
}
