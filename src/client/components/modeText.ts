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

const TONE_TEXT: Record<TextTone, string> = {
  default: 'gray.3',
  muted: 'gray.6',
  accent: 'green.4',
  positive: 'green.3',
  warning: 'yellow.4',
  danger: 'red.4',
};

const TONE_SLOT: Record<TextTone, { color: string; background: string }> = {
  default: { color: 'var(--mantine-color-gray-3)', background: 'var(--mantine-color-dark-6)' },
  muted: { color: 'var(--mantine-color-gray-6)', background: 'var(--mantine-color-dark-6)' },
  accent: { color: 'var(--mantine-color-green-3)', background: 'var(--mantine-color-green-9)' },
  positive: { color: 'var(--mantine-color-green-3)', background: 'var(--mantine-color-green-9)' },
  warning: { color: 'var(--mantine-color-yellow-3)', background: 'var(--mantine-color-yellow-9)' },
  danger: { color: 'var(--mantine-color-red-3)', background: 'var(--mantine-color-red-9)' },
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
