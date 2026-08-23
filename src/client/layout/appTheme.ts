import type { MantineThemeOverride } from '@mantine/core';

/** Shared application theme for the frontend and scoring device. */
export const appTheme: MantineThemeOverride = {
  primaryColor: 'green',
  primaryShade: 6,
  defaultRadius: 'md',
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  components: {
    Button: {
      defaultProps: { radius: 'md' },
    },
    Card: {
      defaultProps: { shadow: 'sm' },
    },
  },
};
