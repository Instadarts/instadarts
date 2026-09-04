import { createTheme } from '@mantine/core';
import type { CSSVariablesResolver, MantineThemeOverride } from '@mantine/core';
import { appPalette } from './palette';
import type { AppTokens } from './palette';

/**
 * Shared application theme for the frontend and scoring device.
 *
 * Colour lives in `palette.ts`; this file spends it. The two halves arrive differently:
 * `colors`/`white`/`black` substitute Mantine's own tuples, so every shade-pinned prop already in
 * the application resolves to the palette, and `appCssVariables` emits the semantic tokens per
 * colour scheme for the components that should not be naming a shade at all.
 */

/** `surfaceHeader` becomes `--instadarts-surface-header`. */
function tokenVariables(tokens: AppTokens): Record<`--${string}`, string> {
  const variables: Record<`--${string}`, string> = {};
  for (const [name, value] of Object.entries(tokens)) {
    variables[`--instadarts-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = value;
  }
  return variables;
}

/**
 * The application's own CSS custom properties, one set per colour scheme.
 *
 * Mantine emits these under `:root` and the two `[data-mantine-color-scheme]` selectors, which is
 * why the application needs no PostCSS plugin and adds no rule set to `index.css` to get a second
 * scheme. `--mantine-color-default-border` is redirected here so that every `withBorder` surface in
 * both applications follows the palette from one line.
 */
export const appCssVariables: CSSVariablesResolver = () => ({
  variables: {
    '--mantine-color-default-border': 'var(--instadarts-border)',
    // `c="dimmed"` is used in roughly twenty places and resolves to a Mantine grey, which no palette
    // rule covers. Pointing it at the muted tone puts it under the same contract as the token, so
    // the two cannot disagree and the palette test guards both.
    '--mantine-color-dimmed': 'var(--instadarts-tone-muted-fg)',
  },
  light: tokenVariables(appPalette.tokens.light),
  dark: tokenVariables(appPalette.tokens.dark),
});

export const appTheme: MantineThemeOverride = createTheme({
  colors: appPalette.scales,
  white: appPalette.white,
  black: appPalette.black,
  primaryColor: 'green',
  // The filled primary has to hold white text on a card in either scheme; 7 is too dark to read as
  // a live control on charcoal, and 6 is too light to hold white text on paper.
  primaryShade: { light: 7, dark: 6 },

  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  // Deliberately no `fontSizes` override: several e2e specs measure computed font sizes, and the
  // match headline's auto-fit result is asserted exactly.
  headings: { fontWeight: '700' },

  defaultRadius: 'md',
  // Tighter than stock Mantine at the top end. A 12 px card corner reads as equipment; Mantine's
  // 16 px reads as a web dashboard.
  radius: { xs: '0.25rem', sm: '0.375rem', md: '0.5rem', lg: '0.75rem', xl: '1rem' },

  // Written in terms of the two shadow tokens, so one shadow scale serves both schemes: soft and
  // warm over paper, tight and near-black over charcoal.
  shadows: {
    xs: '0 1px 2px var(--instadarts-shadow-ambient)',
    sm: '0 1px 2px var(--instadarts-shadow-ambient), 0 2px 6px var(--instadarts-shadow-key)',
    md: '0 2px 4px var(--instadarts-shadow-ambient), 0 6px 16px var(--instadarts-shadow-key)',
    lg: '0 4px 8px var(--instadarts-shadow-ambient), 0 12px 28px var(--instadarts-shadow-key)',
    xl: '0 8px 16px var(--instadarts-shadow-ambient), 0 24px 48px var(--instadarts-shadow-key)',
  },

  components: {
    Button: { defaultProps: { radius: 'md' }, styles: { root: { fontWeight: 600 } } },
    Card: { defaultProps: { shadow: 'sm' } },
    Paper: { defaultProps: { radius: 'md' } },
    Alert: { defaultProps: { radius: 'md' } },
    Menu: { defaultProps: { radius: 'md' } },
    Modal: { defaultProps: { radius: 'lg' } },
    Title: { styles: { root: { letterSpacing: '-0.02em' } } },
  },
});
