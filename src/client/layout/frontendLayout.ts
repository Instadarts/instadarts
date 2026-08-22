import { DEFAULT_COLS, type DefaultBreakpoints, type Layout, type LayoutItem, type ResponsiveLayouts } from 'react-grid-layout';

export type MatchLayoutProfile = 'match-live' | 'match-summary';
export type FrontendBreakpoint = DefaultBreakpoints;

export interface StoredMatchLayouts {
  version: 1;
  profiles: Partial<Record<MatchLayoutProfile, ResponsiveLayouts<FrontendBreakpoint>>>;
}

export const MATCH_LAYOUT_STORAGE_KEY = 'instadarts_frontend_layout_v1';
export const MATCH_LAYOUT_VERSION = 1;
export const FRONTEND_BREAKPOINTS: readonly FrontendBreakpoint[] = ['lg', 'md', 'sm', 'xs', 'xxs'];
export const MATCH_LAYOUT_PROFILES: readonly MatchLayoutProfile[] = ['match-live', 'match-summary'];

const MAX_SAVED_GRID_VALUE = 10_000;

export const LIVE_MATCH_LAYOUT: Layout = [
  { i: 'overview', x: 0, y: 0, w: 12, h: 6, static: true },
  { i: 'scores', x: 0, y: 6, w: 3, h: 18, minW: 1, minH: 8, isBounded: true },
  { i: 'mode-panel', x: 0, y: 24, w: 3, h: 12, minW: 1, minH: 6, isBounded: true },
  { i: 'board', x: 3, y: 6, w: 6, h: 36, minW: 2, minH: 18, isBounded: true },
  { i: 'visit', x: 3, y: 42, w: 6, h: 18, minW: 2, minH: 8, isBounded: true },
  { i: 'history', x: 9, y: 6, w: 3, h: 36, minW: 1, minH: 8, isBounded: true },
];

export const SUMMARY_MATCH_LAYOUT: Layout = [
  { i: 'overview', x: 0, y: 0, w: 12, h: 6, static: true },
  { i: 'result', x: 0, y: 6, w: 7, h: 22, minW: 2, minH: 10, isBounded: true },
  { i: 'match-history', x: 7, y: 6, w: 5, h: 22, minW: 1, minH: 8, isBounded: true },
  { i: 'rematch', x: 0, y: 28, w: 12, h: 14, minW: 2, minH: 8, isBounded: true },
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

function defaultById(defaultLayout: Layout): Map<string, LayoutItem> {
  return new Map(defaultLayout.map((item) => [item.i, item]));
}

function positionFor(raw: unknown, fallback: LayoutItem, cols: number): LayoutItem | null {
  if (!isRecord(raw) || raw.i !== fallback.i) return null;
  const x = finiteInteger(raw.x);
  const y = finiteInteger(raw.y);
  const w = finiteInteger(raw.w);
  const h = finiteInteger(raw.h);
  if (
    x === null || y === null || w === null || h === null
    || x < 0 || y < 0 || w <= 0 || h <= 0
    || x > MAX_SAVED_GRID_VALUE || y > MAX_SAVED_GRID_VALUE
    || w > MAX_SAVED_GRID_VALUE || h > MAX_SAVED_GRID_VALUE
  ) return null;

  const minW = Math.min(cols, fallback.minW ?? 1);
  const maxW = Math.min(cols, fallback.maxW ?? cols);
  const width = Math.max(minW, Math.min(maxW, w));
  const minH = fallback.minH ?? 1;
  const maxH = fallback.maxH ?? MAX_SAVED_GRID_VALUE;
  return {
    ...fallback,
    x: Math.max(0, Math.min(cols - width, x)),
    y,
    w: width,
    h: Math.max(minH, Math.min(maxH, h)),
  };
}

function defaultAtBreakpoint(item: LayoutItem, cols: number): LayoutItem {
  const minW = Math.min(cols, item.minW ?? 1);
  const w = Math.max(minW, Math.min(cols, item.w));
  return { ...item, x: Math.max(0, Math.min(cols - w, item.x)), w };
}

/**
 * Restores positions only. Constraints and static/editable flags always come from current code, so
 * a stale browser cannot preserve rules that no longer belong to an item.
 */
export function mergeResponsiveLayouts(
  rawLayouts: unknown,
  defaultLayout: Layout,
  activeIds: readonly string[],
): ResponsiveLayouts<FrontendBreakpoint> {
  const wanted = new Set(activeIds);
  const defaults = defaultById(defaultLayout);
  const result: ResponsiveLayouts<FrontendBreakpoint> = {};
  const source = isRecord(rawLayouts) ? rawLayouts : {};

  for (const breakpoint of FRONTEND_BREAKPOINTS) {
    const raw = source[breakpoint];
    if (!Array.isArray(raw)) continue;
    const cols = DEFAULT_COLS[breakpoint];
    const seen = new Set<string>();
    const layout: LayoutItem[] = [];

    for (const candidate of raw) {
      if (!isRecord(candidate) || typeof candidate.i !== 'string' || seen.has(candidate.i)) continue;
      const fallback = defaults.get(candidate.i);
      if (!fallback || !wanted.has(candidate.i)) continue;
      const restored = positionFor(candidate, fallback, cols);
      if (!restored) continue;
      seen.add(candidate.i);
      layout.push(restored);
    }

    for (const item of defaultLayout) {
      if (wanted.has(item.i) && !seen.has(item.i)) layout.push(defaultAtBreakpoint(item, cols));
    }
    result[breakpoint] = layout;
  }

  // The largest layout is the canonical seed RGL uses to generate any breakpoint not yet saved.
  if (!result.lg) {
    result.lg = defaultLayout.filter((item) => wanted.has(item.i)).map((item) => ({ ...item }));
  }
  return result;
}

export function parseStoredMatchLayouts(raw: string | null): StoredMatchLayouts | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== MATCH_LAYOUT_VERSION || !isRecord(value.profiles)) return null;

    const profiles: StoredMatchLayouts['profiles'] = {};
    for (const profile of MATCH_LAYOUT_PROFILES) {
      const candidate = value.profiles[profile];
      if (!isRecord(candidate)) continue;
      const layouts: ResponsiveLayouts<FrontendBreakpoint> = {};
      for (const breakpoint of FRONTEND_BREAKPOINTS) {
        const layout = candidate[breakpoint];
        if (Array.isArray(layout)) layouts[breakpoint] = layout as Layout;
      }
      profiles[profile] = layouts;
    }
    return { version: MATCH_LAYOUT_VERSION, profiles };
  } catch {
    return null;
  }
}

export function loadMatchLayouts(
  profile: MatchLayoutProfile,
  defaultLayout: Layout,
  activeIds: readonly string[],
): ResponsiveLayouts<FrontendBreakpoint> {
  try {
    const stored = parseStoredMatchLayouts(localStorage.getItem(MATCH_LAYOUT_STORAGE_KEY));
    return mergeResponsiveLayouts(stored?.profiles[profile], defaultLayout, activeIds);
  } catch {
    return mergeResponsiveLayouts(null, defaultLayout, activeIds);
  }
}

export function saveMatchLayouts(
  profile: MatchLayoutProfile,
  layouts: ResponsiveLayouts<FrontendBreakpoint>,
): void {
  try {
    const previous = parseStoredMatchLayouts(localStorage.getItem(MATCH_LAYOUT_STORAGE_KEY));
    const stored: StoredMatchLayouts = {
      version: MATCH_LAYOUT_VERSION,
      profiles: { ...previous?.profiles, [profile]: layouts },
    };
    localStorage.setItem(MATCH_LAYOUT_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // A layout preference must never prevent the match from rendering.
  }
}

export function resetMatchLayout(profile: MatchLayoutProfile): void {
  try {
    const previous = parseStoredMatchLayouts(localStorage.getItem(MATCH_LAYOUT_STORAGE_KEY));
    if (!previous) return;
    const profiles = { ...previous.profiles };
    delete profiles[profile];
    localStorage.setItem(MATCH_LAYOUT_STORAGE_KEY, JSON.stringify({ version: MATCH_LAYOUT_VERSION, profiles }));
  } catch {
    // The in-memory layout is reset by the caller either way.
  }
}
