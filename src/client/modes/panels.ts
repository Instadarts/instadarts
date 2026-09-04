import type { ComponentType } from 'react';
import type { ModePanel } from '../../shared/types';

/**
 * A game mode's optional second file: a component that draws its panel better than the generic
 * renderer can.
 *
 * It **replaces** the generic table rather than adding to it, and it is handed the whole panel — the
 * same rows any mode describes, plus whatever that mode put in `custom` for its own use. So the two
 * halves degrade into each other: delete the file and the panel keeps working as a plain table, add
 * one and the same data is drawn however the mode likes.
 *
 * Registration is by filename, not by an entry in a list: drop `src/client/modes/<mode id>.tsx`
 * exporting a component as default, and it is picked up on the next build. Deleting the file removes
 * it. There is nothing here to edit either way.
 */
export interface ModePanelProps {
  panel: ModePanel;
}

const found = import.meta.glob<{ default: ComponentType<ModePanelProps> }>('./*.tsx', { eager: true });

export const MODE_PANELS: Record<string, ComponentType<ModePanelProps>> = Object.fromEntries(
  Object.entries(found).map(([path, module]) => [path.replace(/^\.\/|\.tsx$/g, ''), module.default]),
);
