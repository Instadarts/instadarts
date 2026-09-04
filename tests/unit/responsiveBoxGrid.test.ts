import { describe, expect, it } from 'vitest';
import { ResponsiveBoxGrid } from '../../src/client/layout/ResponsiveBoxGrid';
import { HOME_LAYOUTS, LIVE_MATCH_LAYOUTS } from '../../src/client/layout/frontendLayout';

/**
 * The grid is called as a plain function here, which works because the canonical-set check is
 * deliberately the first thing it does — ahead of every hook, so a missing entry is reported at the
 * first render instead of surfacing later as a card that is quietly not there.
 */
describe('the canonical card set', () => {
  it('rejects a match item that has no lg default, naming it', () => {
    expect(() => ResponsiveBoxGrid({
      items: [
        ...(LIVE_MATCH_LAYOUTS.lg ?? []).map((item) => ({ id: item.i, content: null })),
        { id: 'ghost', content: null },
      ],
      defaultLayouts: LIVE_MATCH_LAYOUTS,
      profile: 'match-live',
    })).toThrow('ResponsiveBoxGrid item "ghost" has no lg default layout');
  });

  it('rejects a document item too, where the item would only be misplaced', () => {
    expect(() => ResponsiveBoxGrid({
      items: [{ id: 'welcome', content: null }, { id: 'ghost', content: null }],
      defaultLayouts: HOME_LAYOUTS,
    })).toThrow('"ghost"');
  });

  it('lets a complete item set through', () => {
    // Everything past the check needs a real render, so the call still throws — just not this.
    expect(() => ResponsiveBoxGrid({
      items: (LIVE_MATCH_LAYOUTS.lg ?? []).map((item) => ({ id: item.i, content: null })),
      defaultLayouts: LIVE_MATCH_LAYOUTS,
      profile: 'match-live',
    })).not.toThrow(/no lg default layout/);
  });
});
