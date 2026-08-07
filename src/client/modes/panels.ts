import type { ComponentType } from 'react';

/**
 * A game mode's optional second file: a component that draws what declarative data cannot.
 *
 * Most modes need none — a mode describes its panel as rows in its server file, and the match screen
 * renders that generically. This exists for the mode that genuinely must draw something, and it is
 * fed whatever that mode put in `panel.custom`.
 *
 * Registration is by filename, not by an entry in a list: drop `src/client/modes/<mode id>.tsx`
 * exporting a component as default, and it is picked up on the next build. Deleting the file removes
 * it. There is nothing here to edit either way.
 */
export interface ModePanelProps {
  payload: unknown;
}

const found = import.meta.glob<{ default: ComponentType<ModePanelProps> }>('./*.tsx', { eager: true });

export const MODE_PANELS: Record<string, ComponentType<ModePanelProps>> = Object.fromEntries(
  Object.entries(found).map(([path, module]) => [path.replace(/^\.\/|\.tsx$/g, ''), module.default]),
);
