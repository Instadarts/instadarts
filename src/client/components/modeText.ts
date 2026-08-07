// Turning a mode's text hints into classes.
//
// This is the only place in the app that decides what `danger` looks like. A mode names a meaning;
// the element it lands in supplies the defaults for whatever the mode did not name, and this file
// resolves the two into classes.
//
// Class strings are written out in full rather than composed (`text-red-400`, never
// `text-${colour}-400`) because Tailwind scans this source for the classes it emits.

import { styleOf } from '../../shared/types';
import type { TextStyle, TextTone, ViewText } from '../../shared/types';

const TONE_TEXT: Record<TextTone, string> = {
  default: 'text-gray-300',
  muted: 'text-gray-500',
  accent: 'text-green-400',
  positive: 'text-green-300',
  warning: 'text-yellow-400',
  danger: 'text-red-400',
};

/** The same meanings on a filled dart slot, which carries a background as well. */
const TONE_SLOT: Record<TextTone, string> = {
  default: 'bg-gray-800 text-gray-300',
  muted: 'bg-gray-800 text-gray-600',
  accent: 'bg-green-900 text-green-300',
  positive: 'bg-green-900 text-green-300',
  warning: 'bg-yellow-900 text-yellow-300',
  danger: 'bg-red-900 text-red-300',
};

const SIZE = {
  xs: 'text-xs', sm: 'text-sm', base: 'text-base', lg: 'text-lg',
  xl: 'text-xl', '2xl': 'text-2xl', '3xl': 'text-3xl', '4xl': 'text-4xl',
} as const;

const WEIGHT = {
  normal: 'font-normal', medium: 'font-medium', semibold: 'font-semibold', bold: 'font-bold',
} as const;

/**
 * Classes for a piece of mode text.
 *
 * @param value    what the mode sent — a bare string takes every default
 * @param base     what this element looks like when the mode says nothing
 * @param extra    the element's own non-negotiable classes (layout, font family)
 */
export function modeTextClasses(value: ViewText | undefined, base: TextStyle = {}, extra = ''): string {
  return resolve(styleOf(value), base, TONE_TEXT, extra);
}

/** As above, for a filled dart slot: the tone brings a background with it. */
export function slotClasses(value: ViewText | undefined, base: TextStyle = {}, extra = ''): string {
  return resolve(styleOf(value), base, TONE_SLOT, extra);
}

function resolve(hint: TextStyle, base: TextStyle, tones: Record<TextTone, string>, extra: string): string {
  return [
    tones[hint.tone ?? base.tone ?? 'default'],
    SIZE[hint.size ?? base.size ?? 'base'],
    WEIGHT[hint.weight ?? base.weight ?? 'normal'],
    extra,
  ].filter(Boolean).join(' ');
}
