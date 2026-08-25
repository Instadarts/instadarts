import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COLS, type Layout, type ResponsiveLayouts } from 'react-grid-layout';
import {
  FRONTEND_BREAKPOINTS,
  HOME_LAYOUTS,
  JOIN_LAYOUTS,
  LIVE_MATCH_LAYOUTS,
  MATCH_LAYOUT_STORAGE_KEY,
  MATCH_LAYOUT_VERSION,
  SUMMARY_MATCH_LAYOUTS,
  loadMatchLayoutState,
  mergeResponsiveLayouts,
  parseStoredMatchLayouts,
  reconcileMatchLayoutState,
  resetMatchLayout,
  saveMatchLayoutState,
  setMatchLayoutItemEnabled,
  setMatchTitleBarVisible,
  type FrontendBreakpoint,
  type MatchLayoutItemPreference,
} from '../../src/client/layout/frontendLayout';

const defaults: Layout = [
  { i: 'alpha', x: 0, y: 0, w: 8, h: 5, minW: 2, minH: 3, static: true },
  { i: 'beta', x: 8, y: 0, w: 4, h: 5, minW: 1, minH: 2 },
];

const optionalItems: MatchLayoutItemPreference[] = [
  { id: 'alpha', optional: false, defaultTitleBarVisible: false },
  { id: 'beta', optional: true, defaultEnabled: false, defaultTitleBarVisible: true },
];

let values: Record<string, string>;
let previousStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  values = {};
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => { values[key] = value; },
      removeItem: (key: string) => { delete values[key]; },
    },
  });
});

afterEach(() => {
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('generated frontend page layouts', () => {
  it('centers single-column pages at every stock breakpoint', () => {
    for (const breakpoint of FRONTEND_BREAKPOINTS) {
      const cols = DEFAULT_COLS[breakpoint];
      for (const layouts of [HOME_LAYOUTS, JOIN_LAYOUTS]) {
        for (const item of layouts[breakpoint] ?? []) {
          expect(item.x).toBe((cols - item.w) / 2);
        }
      }
    }
  });

  it('declares an in-bounds match default for every stock breakpoint', () => {
    for (const layouts of [LIVE_MATCH_LAYOUTS, SUMMARY_MATCH_LAYOUTS]) {
      for (const breakpoint of FRONTEND_BREAKPOINTS) {
        const layout = layouts[breakpoint];
        expect(layout).toBeDefined();
        for (const item of layout ?? []) {
          expect(item.x).toBeGreaterThanOrEqual(0);
          expect(item.x + item.w).toBeLessThanOrEqual(DEFAULT_COLS[breakpoint]);
        }
      }
    }
  });

  it('keeps summary framing full-width and canonical boxes non-overlapping', () => {
    for (const breakpoint of FRONTEND_BREAKPOINTS) {
      const cols = DEFAULT_COLS[breakpoint];
      const layout = SUMMARY_MATCH_LAYOUTS[breakpoint] ?? [];
      expect(layout.map((item) => item.i)).toEqual(['overview', 'result', 'match-history', 'rematch']);

      const overview = layout.find((item) => item.i === 'overview');
      const rematch = layout.find((item) => item.i === 'rematch');
      expect(overview).toMatchObject({ x: 0, y: 0, w: cols, static: true });
      expect(rematch).toMatchObject({ x: 0, w: cols, minW: 2, minH: 8 });

      for (const [index, item] of layout.entries()) {
        for (const other of layout.slice(index + 1)) {
          const separated = item.x + item.w <= other.x
            || other.x + other.w <= item.x
            || item.y + item.h <= other.y
            || other.y + other.h <= item.y;
          expect(separated, `${breakpoint}: ${item.i} overlaps ${other.i}`).toBe(true);
        }
      }
    }
  });

  it('uses balanced result columns through sm and a full-width stack below it', () => {
    for (const breakpoint of ['lg', 'md', 'sm'] as const) {
      const cols = DEFAULT_COLS[breakpoint];
      const layout = SUMMARY_MATCH_LAYOUTS[breakpoint] ?? [];
      expect(layout.find((item) => item.i === 'result')).toMatchObject({ x: 0, w: cols / 2, y: 4, h: 12 });
      expect(layout.find((item) => item.i === 'match-history')).toMatchObject({ x: cols / 2, w: cols / 2, y: 4, h: 12 });
    }

    for (const breakpoint of ['xs', 'xxs'] as const) {
      const cols = DEFAULT_COLS[breakpoint];
      for (const item of SUMMARY_MATCH_LAYOUTS[breakpoint] ?? []) {
        expect(item).toMatchObject({ x: 0, w: cols });
      }
    }
  });

  it('appends visit history after the live layout at a useful responsive width', () => {
    for (const breakpoint of FRONTEND_BREAKPOINTS) {
      const layout = LIVE_MATCH_LAYOUTS[breakpoint] ?? [];
      const history = layout.find((item) => item.i === 'history');
      const withoutHistory = layout.filter((item) => item.i !== 'history');
      expect(history).toBeDefined();
      expect(history).toMatchObject({ h: 20, minH: 8 });
      expect(history!.y).toBeGreaterThanOrEqual(
        Math.max(...withoutHistory.map((item) => item.y + item.h)),
      );

      const cols = DEFAULT_COLS[breakpoint];
      if (breakpoint === 'xs' || breakpoint === 'xxs') expect(history!.w).toBe(cols);
      else expect(history!.w).toBe(layout.find((item) => item.i === 'scores')!.w);
    }
  });
});

describe('optional match cards', () => {
  it('places default-disabled cards in the inactive pool and repairs mandatory cards', () => {
    const state = reconcileMatchLayoutState(
      { lg: [] },
      { lg: [{ i: 'alpha', x: 3, y: 8, w: 2, h: 3 }] },
      defaults,
      optionalItems,
    );

    for (const breakpoint of FRONTEND_BREAKPOINTS) {
      expect(state.layouts[breakpoint]?.map((item) => item.i)).toEqual(['alpha']);
      expect(state.inactive[breakpoint]?.map((item) => item.i)).toEqual(['beta']);
    }
    expect(state.layouts.lg?.[0]).toEqual(defaults[0]);
  });

  it('restores a saved enabled state at one breakpoint without enabling the others', () => {
    const state = reconcileMatchLayoutState({
      sm: [
        { ...defaults[0], x: 0 },
        { ...defaults[1], x: 2, y: 11, w: 4, h: 6 },
      ],
    }, null, defaults, optionalItems);

    expect(state.layouts.sm?.map((item) => item.i)).toEqual(['alpha', 'beta']);
    expect(state.layouts.sm?.find((item) => item.i === 'beta')).toMatchObject({ y: 11, h: 6 });
    expect(state.inactive.sm).toEqual([]);
    expect(state.layouts.lg?.map((item) => item.i)).toEqual(['alpha']);
    expect(state.inactive.lg?.map((item) => item.i)).toEqual(['beta']);
  });

  it('moves the complete layout item between collections without changing its geometry', () => {
    const initial = reconcileMatchLayoutState({
      lg: [defaults[0], { ...defaults[1], x: 3, y: 17, w: 5, h: 9 }],
    }, null, defaults, optionalItems);
    const before = initial.layouts.lg?.find((item) => item.i === 'beta');

    const disabled = setMatchLayoutItemEnabled(initial, 'lg', 'beta', false);
    expect(disabled.layouts.lg?.some((item) => item.i === 'beta')).toBe(false);
    expect(disabled.inactive.lg?.find((item) => item.i === 'beta')).toEqual(before);

    const enabled = setMatchLayoutItemEnabled(disabled, 'lg', 'beta', true);
    expect(enabled.layouts.lg?.find((item) => item.i === 'beta')).toEqual(before);
    expect(enabled.inactive.lg).toEqual([]);
  });

  it('keeps an enabled card enabled when its saved position is unusable', () => {
    const state = reconcileMatchLayoutState({
      lg: [defaults[0], { ...defaults[1], w: 0 }],
    }, null, defaults, optionalItems);

    // Geometry and enablement are separate questions. A mandatory card with the same corruption is
    // repaired to its default position, and an optional one the user switched on must be too --
    // reading the rejected entry as an absent one would switch the card off instead.
    expect(state.layouts.lg?.map((item) => item.i)).toEqual(['alpha', 'beta']);
    expect(state.layouts.lg?.find((item) => item.i === 'beta')).toEqual(defaults[1]);
    expect(state.inactive.lg).toEqual([]);
  });

  it('drops unknown, malformed and mandatory inactive entries', () => {
    const state = reconcileMatchLayoutState(null, {
      lg: [
        { i: 'alpha', x: 0, y: 0, w: 8, h: 5 },
        { i: 'beta', x: -1, y: 0, w: 4, h: 5 },
        { i: 'unknown', x: 0, y: 0, w: 1, h: 1 },
      ],
    }, defaults, optionalItems);

    expect(state.layouts.lg?.map((item) => item.i)).toEqual(['alpha']);
    expect(state.inactive.lg).toEqual([defaults[1]]);
  });
});

describe('match card title bars', () => {
  it('uses each card default independently at every breakpoint', () => {
    const state = reconcileMatchLayoutState(null, null, defaults, optionalItems);

    for (const breakpoint of FRONTEND_BREAKPOINTS) {
      expect(state.titleBars[breakpoint]).toEqual({ alpha: false, beta: true });
    }
  });

  it('changes one breakpoint without affecting geometry or other breakpoints', () => {
    const initial = reconcileMatchLayoutState(null, null, defaults, optionalItems);
    const updated = setMatchTitleBarVisible(initial, 'lg', 'alpha', true);

    expect(updated.layouts).toEqual(initial.layouts);
    expect(updated.inactive).toEqual(initial.inactive);
    expect(updated.titleBars.lg?.alpha).toBe(true);
    expect(updated.titleBars.sm?.alpha).toBe(false);
  });

  it('accepts only boolean values for currently available cards', () => {
    const state = reconcileMatchLayoutState(
      null,
      null,
      defaults,
      optionalItems,
      undefined,
      { lg: { alpha: 'hidden', beta: false, unknown: true } },
    );

    expect(state.titleBars.lg).toEqual({ alpha: false, beta: false });
  });
});

describe('stored frontend match layouts', () => {
  it('rejects invalid JSON and old schema versions', () => {
    expect(parseStoredMatchLayouts(null)).toBeNull();
    expect(parseStoredMatchLayouts('{not json')).toBeNull();
    expect(parseStoredMatchLayouts(JSON.stringify({
      version: MATCH_LAYOUT_VERSION - 1,
      profiles: {},
    }))).toBeNull();
  });

  it('keeps only known profiles and breakpoints from the storage envelope', () => {
    const parsed = parseStoredMatchLayouts(JSON.stringify({
      version: MATCH_LAYOUT_VERSION,
      profiles: {
        'match-live': { lg: [], tablet: [{ i: 'alpha', x: 0, y: 0, w: 1, h: 1 }] },
        unknown: { lg: [] },
      },
    }));

    expect(parsed?.profiles).toEqual({ 'match-live': { lg: [] } });
  });

  it('restores valid positions while reapplying current constraints', () => {
    const restored = mergeResponsiveLayouts({
      xs: [
        { i: 'alpha', x: 3, y: 7, w: 99, h: 1, static: false },
        { i: 'unknown', x: 0, y: 0, w: 1, h: 1 },
      ],
    }, defaults, ['alpha', 'beta']);

    expect(restored.xs?.map((item) => item.i)).toEqual(['alpha', 'beta']);
    expect(restored.xs?.[0]).toMatchObject({
      i: 'alpha', x: 0, y: 7, w: 4, h: 3, minW: 2, minH: 3, static: true,
    });
  });

  it('discards malformed coordinates and merges newly introduced boxes', () => {
    const restored = mergeResponsiveLayouts({
      lg: [{ i: 'alpha', x: -1, y: 0, w: 8, h: 5 }],
    }, defaults, ['alpha', 'beta']);

    expect(restored.lg).toEqual(defaults);
  });

  it('uses explicit defaults for each unsaved breakpoint and newly introduced box', () => {
    const responsiveDefaults: ResponsiveLayouts<FrontendBreakpoint> = {
      lg: defaults,
      sm: [
        { i: 'alpha', x: 0, y: 2, w: 4, h: 7, minW: 2, minH: 4, static: true },
        { i: 'beta', x: 4, y: 2, w: 2, h: 7, minW: 2, minH: 3 },
      ],
    };

    const fresh = mergeResponsiveLayouts(null, defaults, ['alpha', 'beta'], responsiveDefaults);
    expect(fresh.sm).toEqual(responsiveDefaults.sm);

    const restored = mergeResponsiveLayouts({
      sm: [{ i: 'alpha', x: 1, y: 9, w: 3, h: 5 }],
    }, defaults, ['alpha', 'beta'], responsiveDefaults);
    expect(restored.sm?.[0]).toMatchObject({ i: 'alpha', x: 1, y: 9, w: 3, h: 5, minH: 4, static: true });
    expect(restored.sm?.[1]).toEqual(responsiveDefaults.sm?.[1]);
  });

  it('preserves independent layouts for every saved breakpoint and profile', () => {
    const live: ResponsiveLayouts<FrontendBreakpoint> = {
      lg: [{ i: 'alpha', x: 2, y: 1, w: 8, h: 5 }],
      sm: [{ i: 'alpha', x: 0, y: 9, w: 6, h: 6 }],
    };
    const summary: ResponsiveLayouts<FrontendBreakpoint> = {
      md: [{ i: 'alpha', x: 1, y: 4, w: 8, h: 7 }],
    };

    saveMatchLayoutState(
      'match-live',
      reconcileMatchLayoutState(live, null, defaults, optionalItems),
    );
    saveMatchLayoutState(
      'match-summary',
      reconcileMatchLayoutState(summary, null, defaults, optionalItems),
    );

    const stored = parseStoredMatchLayouts(values[MATCH_LAYOUT_STORAGE_KEY] ?? null);
    expect(stored?.profiles['match-live']?.sm?.[0]).toMatchObject({ y: 9, h: 6 });
    expect(stored?.profiles['match-summary']?.md?.[0]).toMatchObject({ y: 4, h: 7 });
    expect(loadMatchLayoutState('match-live', defaults, optionalItems).layouts.sm?.[0])
      .toMatchObject({ y: 9, h: 6 });
    expect(loadMatchLayoutState('match-summary', defaults, optionalItems).layouts.md?.[0])
      .toMatchObject({ y: 4, h: 7 });
  });

  it('persists inactive cards additively and loads legacy data without that field', () => {
    const legacy = JSON.stringify({
      version: MATCH_LAYOUT_VERSION,
      profiles: { 'match-live': { lg: [defaults[0]] } },
    });
    values[MATCH_LAYOUT_STORAGE_KEY] = legacy;

    const loaded = loadMatchLayoutState('match-live', defaults, optionalItems);
    expect(loaded.layouts.lg?.map((item) => item.i)).toEqual(['alpha']);
    expect(loaded.inactive.lg?.map((item) => item.i)).toEqual(['beta']);
    expect(loaded.titleBars.lg).toEqual({ alpha: false, beta: true });

    const enabled = setMatchTitleBarVisible(
      setMatchLayoutItemEnabled(loaded, 'lg', 'beta', true),
      'lg',
      'alpha',
      true,
    );
    saveMatchLayoutState('match-live', enabled);
    const stored = parseStoredMatchLayouts(values[MATCH_LAYOUT_STORAGE_KEY] ?? null);
    expect(stored?.profiles['match-live']?.lg?.map((item) => item.i)).toEqual(['alpha', 'beta']);
    expect(stored?.inactive?.['match-live']?.lg).toEqual([]);
    expect(stored?.titleBars?.['match-live']?.lg).toEqual({ alpha: true, beta: true });
  });

  it('keeps the preferences of a card that is temporarily unavailable', () => {
    const placed = reconcileMatchLayoutState(
      { lg: [defaults[0], { ...defaults[1], x: 3, y: 17, w: 4, h: 9 }] },
      null,
      defaults,
      optionalItems,
    );
    saveMatchLayoutState('match-live', setMatchTitleBarVisible(placed, 'lg', 'beta', false));

    // The card leaves the roster -- a mode that draws no panel, a summary with nobody to re-match --
    // so it leaves `itemPreferences` too and the next state saved says nothing about it at all.
    const withoutBeta = reconcileMatchLayoutState(
      placed.layouts,
      placed.inactive,
      defaults,
      [optionalItems[0]],
      undefined,
      placed.titleBars,
    );
    expect(withoutBeta.layouts.lg?.map((item) => item.i)).toEqual(['alpha']);
    saveMatchLayoutState('match-live', withoutBeta);

    const restored = loadMatchLayoutState('match-live', defaults, optionalItems);
    expect(restored.layouts.lg?.find((item) => item.i === 'beta')).toMatchObject({
      x: 3, y: 17, w: 4, h: 9,
    });
    expect(restored.titleBars.lg?.beta).toBe(false);
  });

  it('still overwrites the cards a save does know about', () => {
    const moved = reconcileMatchLayoutState(
      { lg: [{ ...defaults[0], y: 6 }, { ...defaults[1], x: 3, y: 17, w: 4, h: 9 }] },
      null,
      defaults,
      optionalItems,
    );
    saveMatchLayoutState('match-live', moved);
    saveMatchLayoutState('match-live', reconcileMatchLayoutState(
      { lg: [{ ...defaults[0], y: 2 }] },
      null,
      defaults,
      [optionalItems[0]],
    ));

    const restored = loadMatchLayoutState('match-live', defaults, optionalItems);
    expect(restored.layouts.lg?.map((item) => item.i)).toEqual(['alpha', 'beta']);
    expect(restored.layouts.lg?.find((item) => item.i === 'alpha')).toMatchObject({ y: 2 });
  });

  it('resets only the active profile, including all of its breakpoints', () => {
    saveMatchLayoutState('match-summary', reconcileMatchLayoutState({
      xs: [{ i: 'alpha', x: 0, y: 6, w: 4, h: 5 }],
    }, null, defaults, optionalItems));
    saveMatchLayoutState('match-live', reconcileMatchLayoutState(null, null, defaults, optionalItems));

    resetMatchLayout('match-live');

    const stored = parseStoredMatchLayouts(values[MATCH_LAYOUT_STORAGE_KEY] ?? null);
    expect(stored?.profiles['match-live']).toBeUndefined();
    expect(stored?.inactive?.['match-live']).toBeUndefined();
    expect(stored?.titleBars?.['match-live']).toBeUndefined();
    expect(stored?.profiles['match-summary']?.xs?.[0]?.y).toBe(6);
    expect(stored?.inactive?.['match-summary']?.xs?.map((item) => item.i)).toEqual(['beta']);
    expect(stored?.titleBars?.['match-summary']?.xs).toEqual({ alpha: false, beta: true });
    expect(loadMatchLayoutState('match-live', defaults, optionalItems).layouts.lg?.[0]?.y).toBe(0);
  });

  it('deletes layouts from another schema version and loads current defaults', () => {
    values[MATCH_LAYOUT_STORAGE_KEY] = JSON.stringify({
      version: MATCH_LAYOUT_VERSION + 1,
      profiles: {
        'match-live': { lg: [{ i: 'alpha', x: 0, y: 99, w: 8, h: 5 }] },
      },
    });

    const loaded = loadMatchLayoutState('match-live', defaults, optionalItems);

    expect(loaded.layouts.lg?.[0]?.y).toBe(0);
    expect(values[MATCH_LAYOUT_STORAGE_KEY]).toBeUndefined();
  });

  it('falls back to defaults and never interrupts a match when storage is unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
      },
    });

    expect(loadMatchLayoutState('match-live', defaults, optionalItems).layouts.lg)
      .toEqual([defaults[0]]);
    expect(loadMatchLayoutState('match-live', defaults, optionalItems).inactive.lg)
      .toEqual([defaults[1]]);
    expect(() => saveMatchLayoutState(
      'match-live',
      reconcileMatchLayoutState(null, null, defaults, optionalItems),
    )).not.toThrow();
    expect(() => resetMatchLayout('match-live')).not.toThrow();
  });
});
