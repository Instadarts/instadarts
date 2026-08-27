import { ActionIcon, Group, Text, useMantineColorScheme } from '@mantine/core';
import { MoonIcon, SunIcon } from './AppIcons';

/**
 * Bright or dark, for whichever application is rendering it.
 *
 * Both settings menus carry one, and the two remember separately: `main.tsx` gives each application
 * its own `colorSchemeManager`, so this control writes the key belonging to the provider above it
 * without knowing which application that is. It is deliberately the same row shape as the zoom
 * control it sits above — a label, and the thing to press on the right — because they are the same
 * kind of setting, and it is a live control rather than a `Menu.Item` for the same reason zoom is.
 *
 * The icon shows the scheme in force; the accessible name says what pressing it will do.
 */
export function AppearanceControl() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const dark = colorScheme !== 'light';
  const label = dark ? 'Switch to bright appearance' : 'Switch to dark appearance';

  return (
    <Group justify="space-between" gap="md" wrap="nowrap">
      <Text fz="sm">Appearance</Text>
      <ActionIcon
        variant="default"
        size="sm"
        aria-label={label}
        title={label}
        data-testid="appearance-toggle"
        onClick={() => setColorScheme(dark ? 'light' : 'dark')}
      >
        {dark ? <MoonIcon size={15} /> : <SunIcon size={15} />}
      </ActionIcon>
    </Group>
  );
}
