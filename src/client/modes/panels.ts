import type { ComponentType } from 'react';

/**
 * The one place a game mode may put its own code in the client: a component rendered between the
 * player cards and the manual input, fed whatever the mode put in `view.panel`.
 *
 * Everything else the screen shows comes from the mode's view as plain strings, so a mode that needs
 * no graphics of its own — x01 does not — belongs nowhere in the client at all.
 */
export interface ModePanelProps {
  payload: unknown;
}

export const MODE_PANELS: Record<string, ComponentType<ModePanelProps>> = {};
