import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COLS, type Layout, type ResponsiveLayouts } from 'react-grid-layout';
import {
  FRONTEND_BREAKPOINTS,
  HOME_LAYOUTS,
  JOIN_LAYOUTS,
  LIVE_MATCH_LAYOUTS,
  MATCH_LAYOUT_STORAGE_KEY,
  SUMMARY_MATCH_LAYOUTS,
  loadMatchLayouts,
  mergeResponsiveLayouts,
  parseStoredMatchLayouts,
  resetMatchLayout,
  saveMatchLayouts,
  type FrontendBreakpoint,
} from '../../src/client/layout/frontendLayout';

const defaults: Layout = [
  { i: 'alpha', x: 0, y: 0, w: 8, h: 5, minW: 2, minH: 3, static: true },
  { i: 'beta', x: 8, y: 0, w: 4, h: 5, minW: 1, minH: 2 },
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
});

describe('stored frontend match layouts', () => {
  it('rejects invalid JSON and old schema versions', () => {
    expect(parseStoredMatchLayouts(null)).toBeNull();
    expect(parseStoredMatchLayouts('{not json')).toBeNull();
    expect(parseStoredMatchLayouts(JSON.stringify({ version: 0, profiles: {} }))).toBeNull();
  });

  it('keeps only known profiles and breakpoints from the storage envelope', () => {
    const parsed = parseStoredMatchLayouts(JSON.stringify({
      version: 1,
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

    saveMatchLayouts('match-live', live);
    saveMatchLayouts('match-summary', summary);

    const stored = parseStoredMatchLayouts(values[MATCH_LAYOUT_STORAGE_KEY] ?? null);
    expect(stored?.profiles['match-live']).toEqual(live);
    expect(stored?.profiles['match-summary']).toEqual(summary);
    expect(loadMatchLayouts('match-live', defaults, ['alpha']).sm?.[0]).toMatchObject({ y: 9, h: 6 });
    expect(loadMatchLayouts('match-summary', defaults, ['alpha']).md?.[0]).toMatchObject({ y: 4, h: 7 });
  });

  it('resets only the active profile, including all of its breakpoints', () => {
    saveMatchLayouts('match-live', { lg: [{ i: 'alpha', x: 0, y: 5, w: 8, h: 5 }] });
    saveMatchLayouts('match-summary', { xs: [{ i: 'alpha', x: 0, y: 6, w: 4, h: 5 }] });

    resetMatchLayout('match-live');

    const stored = parseStoredMatchLayouts(values[MATCH_LAYOUT_STORAGE_KEY] ?? null);
    expect(stored?.profiles['match-live']).toBeUndefined();
    expect(stored?.profiles['match-summary']?.xs?.[0]?.y).toBe(6);
    expect(loadMatchLayouts('match-live', defaults, ['alpha']).lg?.[0]?.y).toBe(0);
  });
});
