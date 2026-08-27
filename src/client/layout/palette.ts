import type { MantineColorsTuple } from '@mantine/core';

/**
 * The one place a colour is chosen.
 *
 * `scales` replaces Mantine's own colour tuples under their own names, so every `bg="dark.8"`,
 * `c="gray.6"` and `color="yellow"` already in the application resolves through this file without a
 * prop being renamed. `tokens` is the semantic half: a card asks for `var(--instadarts-surface)`
 * rather than for a shade, because the two schemes do not stack their surfaces the same way.
 * `appTheme.ts` emits the tokens as CSS custom properties, one set per colour scheme.
 *
 * To change the application's colours, edit `palette` — or write a second `AppPalette` beside it and
 * change the one export at the bottom.
 */
export interface AppPalette {
  /** Mantine tuples, replacing the built-ins of the same name. */
  scales: {
    dark: MantineColorsTuple;
    gray: MantineColorsTuple;
    green: MantineColorsTuple;
    red: MantineColorsTuple;
    yellow: MantineColorsTuple;
    orange: MantineColorsTuple;
    blue: MantineColorsTuple;
    cyan: MantineColorsTuple;
  };
  /** Drives `--mantine-color-body` in the light scheme. */
  white: string;
  /** Drives `--mantine-color-text` in the light scheme. */
  black: string;
  tokens: { light: AppTokens; dark: AppTokens };
}

/**
 * Every key becomes `--instadarts-<key>` in kebab case. Keep the set small: a token earns its place
 * by being asked for in more than one component, or by needing a different answer in each scheme.
 *
 * The four surfaces are a stack. `sunken` < `surface` < `surfaceHeader` < `raised`, and each step
 * has to be visible against the one below it — see the contrast note under Theming in docs/ui.md.
 */
export interface AppTokens {
  /** The page behind everything, and the two washes laid over it. */
  appBg: string;
  appGlowA: string;
  appGlowB: string;
  /** A card. */
  surface: string;
  /** A card's title bar. */
  surfaceHeader: string;
  /** An inset panel within a card: a dart slot, a stat block, a player row. */
  surfaceRaised: string;
  /** A well within a card: a device box, a mode's stat strip, a player who is not throwing. */
  surfaceSunken: string;
  /** The application header strip. */
  headerBg: string;
  /** Hairlines. `borderStrong` is for a divider that has to be found rather than felt. */
  border: string;
  borderStrong: string;
  /** Match-layout editing: the dashed item outline and the translucent returning title bar. */
  editOutline: string;
  editOverlay: string;
  /**
   * The tones a value can carry, as a foreground and a background each.
   *
   * `modeText.ts` maps a game mode's `TextTone` onto the first six. They are read directly as well —
   * by the match screen, the top bar, the lobby, the scorer's onboarding and both game modes — so
   * retuning one reaches further than the mode panels. `info` has no `TextTone`: it is the third
   * state that is neither good nor bad, and only components use it.
   */
  toneDefaultFg: string;
  toneDefaultBg: string;
  toneMutedFg: string;
  toneMutedBg: string;
  toneAccentFg: string;
  toneAccentBg: string;
  tonePositiveFg: string;
  tonePositiveBg: string;
  toneWarningFg: string;
  toneWarningBg: string;
  toneDangerFg: string;
  toneDangerBg: string;
  toneInfoFg: string;
  toneInfoBg: string;
  /** The brand tint: the wordmark, a connected indicator, a live value worth looking at. */
  accent: string;
  /** A link inside body text, which is deliberately not the brand colour. */
  link: string;
  /** A complete `text-shadow` for the match screen's big score, which sits on a tinted panel. */
  scoreGlow: string;
  /** The `.button-hint` ring — see `index.css`. */
  hintRing: string;
  hintRingFade: string;
  /**
   * `theme.shadows` is scheme-independent, so its strings are written in terms of these two and pick
   * up a per-scheme answer for free.
   */
  shadowAmbient: string;
  shadowKey: string;
}

const palette: AppPalette = {
  scales: {
    dark: [
      '#dde5e1', '#bcc7c2', '#93a29b', '#788a83', '#5a6b64',
      '#42534d', '#35443f', '#26332e', '#1f2b27', '#070b0a',
    ],
    gray: [
      '#f7f4ee', '#efeae0', '#e2dbcd', '#cfc6b4', '#b3a894',
      '#94897a', '#736a5e', '#565045', '#3c372f', '#26231e',
    ],
    green: [
      '#e6f7ec', '#c6ecd5', '#9bdcb5', '#6bc994', '#44b678',
      '#2aa465', '#1e8c53', '#166f42', '#0f5531', '#083a21',
    ],
    red: [
      '#fdeaec', '#f8ccd0', '#f1a2a9', '#e77683', '#dc4f5f',
      '#ce2431', '#b01d28', '#8d1720', '#6a1119', '#470a10',
    ],
    yellow: [
      '#fdf6e5', '#f8e9c4', '#efd696', '#e4bf64', '#d7a83c',
      '#c69426', '#b8861f', '#94691a', '#6f4e14', '#3f2c0b',
    ],
    orange: [
      '#fdf0e3', '#f8dcbe', '#f0c08d', '#e6a15b', '#d98634',
      '#c86f21', '#a9591b', '#864516', '#643311', '#40200a',
    ],
    blue: [
      '#e8f2fa', '#c9e1f3', '#9cc8e6', '#6dacd6', '#4a93c6',
      '#317bb0', '#256595', '#1d5079', '#153b5b', '#0d273d',
    ],
    cyan: [
      '#e4f5f5', '#c0e8e8', '#8ed4d5', '#5bbcbe', '#37a4a7',
      '#238c8f', '#1b7175', '#16595c', '#104144', '#0a2a2c',
    ],
  },

  white: '#fbf8f2',
  black: '#161a19',

  tokens: {
    dark: {
      appBg: '#070b0a',
      appGlowA: 'rgba(42, 164, 101, 0.09)',
      appGlowB: 'rgba(184, 134, 31, 0.05)',
      surface: '#1f2b27',
      surfaceHeader: '#2a3730',
      surfaceRaised: '#35443f',
      surfaceSunken: '#121a18',
      headerBg: '#141d1a',
      border: '#3f4f49',
      borderStrong: '#5a6b64',
      editOutline: '#2aa465',
      editOverlay: 'color-mix(in srgb, #1f2b27 84%, transparent)',
      toneDefaultFg: '#dde5e1',
      toneDefaultBg: '#35443f',
      toneMutedFg: '#a3b1aa',
      toneMutedBg: '#2a3730',
      toneAccentFg: '#7dd3a1',
      toneAccentBg: '#0c4728',
      tonePositiveFg: '#9bdcb5',
      tonePositiveBg: '#0c4728',
      toneWarningFg: '#e4bf64',
      toneWarningBg: '#4a3410',
      toneDangerFg: '#e77683',
      toneDangerBg: '#55131b',
      toneInfoFg: '#8ed4d5',
      toneInfoBg: '#104144',
      accent: '#44b678',
      link: '#6dacd6',
      scoreGlow: '0 0 5px rgba(0, 0, 0, 0.9)',
      hintRing: 'rgba(215, 168, 60, 0.75)',
      hintRingFade: 'rgba(215, 168, 60, 0.14)',
      shadowAmbient: 'rgba(0, 0, 0, 0.55)',
      shadowKey: 'rgba(0, 0, 0, 0.7)',
    },

    light: {
      appBg: '#e6dcc6',
      appGlowA: 'rgba(22, 111, 66, 0.07)',
      appGlowB: 'rgba(184, 134, 31, 0.10)',
      surface: '#fbf8f2',
      surfaceHeader: '#f2ebdd',
      surfaceRaised: '#eae0cb',
      surfaceSunken: '#ded2b9',
      headerBg: '#fbf8f2',
      border: '#cdc0a6',
      borderStrong: '#a3947a',
      editOutline: '#166f42',
      editOverlay: 'color-mix(in srgb, #fbf8f2 86%, transparent)',
      toneDefaultFg: '#26231e',
      toneDefaultBg: '#eae0cb',
      toneMutedFg: '#5c5348',
      toneMutedBg: '#eae0cb',
      toneAccentFg: '#0f5531',
      toneAccentBg: '#c6ecd5',
      tonePositiveFg: '#0f5531',
      tonePositiveBg: '#c6ecd5',
      toneWarningFg: '#7d5814',
      toneWarningBg: '#f8e9c4',
      toneDangerFg: '#8d1720',
      toneDangerBg: '#f8ccd0',
      toneInfoFg: '#16595c',
      toneInfoBg: '#c0e8e8',
      accent: '#166f42',
      link: '#1d5079',
      scoreGlow: '0 0 6px rgba(251, 248, 242, 0.95)',
      hintRing: 'rgba(148, 105, 26, 0.55)',
      hintRingFade: 'rgba(184, 134, 31, 0.16)',
      shadowAmbient: 'rgba(58, 52, 40, 0.10)',
      shadowKey: 'rgba(58, 52, 40, 0.16)',
    },
  },
};

/** The palette the application is built from. Point this at another `AppPalette` to change it. */
export const appPalette: AppPalette = palette;
