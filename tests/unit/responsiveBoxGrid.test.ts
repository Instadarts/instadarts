import { describe, expect, it } from 'vitest';
import { HOME_LAYOUTS, LIVE_MATCH_LAYOUTS, validateResponsiveBoxItems } from '../../src/client/layout/frontendLayout';

// Exercise the same validation the grid runs before its hooks, without rendering a component.
describe('the canonical card set', () => {
  it('rejects a match item that has no lg default, naming it', () => {
    expect(() => validateResponsiveBoxItems([
      ...(LIVE_MATCH_LAYOUTS.lg ?? []).map((item) => ({ id: item.i })),
      { id: 'ghost' },
    ], LIVE_MATCH_LAYOUTS)).toThrow('ResponsiveBoxGrid item "ghost" has no lg default layout');
  });

  it('rejects a document item too, where the item would only be misplaced', () => {
    expect(() => validateResponsiveBoxItems(
      [{ id: 'welcome' }, { id: 'ghost' }], HOME_LAYOUTS,
    )).toThrow('"ghost"');
  });

  it('lets a complete item set through', () => {
    expect(() => validateResponsiveBoxItems(
      (LIVE_MATCH_LAYOUTS.lg ?? []).map((item) => ({ id: item.i })), LIVE_MATCH_LAYOUTS,
    )).not.toThrow();
  });
});
