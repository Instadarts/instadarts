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

interface CenteredStackItem {
  i: string;
  h: number;
}

/** Build a complete layout map without repeating RGL's stock breakpoint/column lookup. */
export function makeResponsiveLayouts(
  makeLayout: (cols: number, breakpoint: FrontendBreakpoint) => Layout,
): ResponsiveLayouts<FrontendBreakpoint> {
  return Object.fromEntries(
    FRONTEND_BREAKPOINTS.map((breakpoint) => [
      breakpoint,
      makeLayout(DEFAULT_COLS[breakpoint], breakpoint),
    ]),
  ) as ResponsiveLayouts<FrontendBreakpoint>;
}

/** Place document-style boxes in one centered column, accumulating their canonical heights. */
export function makeCenteredStackLayout(
  cols: number,
  width: number,
  items: readonly CenteredStackItem[],
): Layout {
  const itemWidth = Math.min(cols, width);
  const x = Math.floor((cols - itemWidth) / 2);
  let y = 0;

  return items.map((item) => {
    const placed = { ...item, x, y, w: itemWidth };
    y += item.h;
    return placed;
  });
}

const CENTERED_PAGE_WIDTHS: Record<FrontendBreakpoint, number> = {
  lg: 6,
  md: 6,
  sm: 4,
  xs: 4,
  xxs: 2,
};

const HOME_BOXES = [
  { i: 'welcome', h: 11 },
  { i: 'actions', h: 16 },
] as const;

export const HOME_LAYOUTS = makeResponsiveLayouts((cols, breakpoint) => (
  makeCenteredStackLayout(cols, CENTERED_PAGE_WIDTHS[breakpoint], HOME_BOXES)
));
export const HOME_LAYOUT = HOME_LAYOUTS.lg!;

const JOIN_BOXES = [{ i: 'status', h: 10 }] as const;

export const JOIN_LAYOUTS = makeResponsiveLayouts((cols, breakpoint) => (
  makeCenteredStackLayout(cols, CENTERED_PAGE_WIDTHS[breakpoint], JOIN_BOXES)
));
export const JOIN_LAYOUT = JOIN_LAYOUTS.lg!;

const LOBBY_BOXES = [
  { i: 'overview', h: 9, fullWidth: true },
  { i: 'players', h: 11 },
  { i: 'match-settings', h: 16 },
  { i: 'mode-settings', h: 16 },
  { i: 'invite', h: 11 },
] as const;

export interface BalancedCardLayoutOptions {
  minimumCardWidth: number;
  maximumCardWidth: number;
  maximumCardsPerRow: number;
}

interface BalancedCardLayoutItem {
  i: string;
  h: number;
  fullWidth?: boolean;
}

/**
 * Place equal-width cards in centered rows, with optional full-width items outside those rows.
 * Vertical collision handling derives every y coordinate after the horizontal positions are set.
 */
export function makeBalancedCardLayout(
  cols: number,
  items: readonly BalancedCardLayoutItem[],
  { minimumCardWidth, maximumCardWidth, maximumCardsPerRow }: BalancedCardLayoutOptions,
): Layout {
  const maximumFittingCards = Math.min(
    maximumCardsPerRow,
    Math.max(1, Math.floor(cols / minimumCardWidth)),
  );

  let cardsPerRow = 1;
  let cardWidth = Math.min(cols, maximumCardWidth);

  if (cols >= minimumCardWidth) {
    let found = false;

    // Prefer an equal-width arrangement that consumes the complete row.
    for (let count = maximumFittingCards; count >= 1 && !found; count -= 1) {
      const width = cols / count;
      if (Number.isInteger(width) && width >= minimumCardWidth && width <= maximumCardWidth) {
        cardsPerRow = count;
        cardWidth = width;
        found = true;
      }
    }

    // Otherwise accept only an even remainder, so both sides receive the same empty space.
    for (let count = maximumFittingCards; count >= 1 && !found; count -= 1) {
      for (let width = maximumCardWidth; width >= minimumCardWidth; width -= 1) {
        const remainder = cols - count * width;
        if (remainder >= 0 && remainder % 2 === 0) {
          cardsPerRow = count;
          cardWidth = width;
          found = true;
          break;
        }
      }
    }
  }

  const rowWidth = cardsPerRow * cardWidth;
  const rowOffset = (cols - rowWidth) / 2;
  let cardIndex = 0;

  return items.map((item) => {
    if (item.fullWidth) return { i: item.i, x: 0, y: 0, w: cols, h: item.h };
    const x = rowOffset + (cardIndex % cardsPerRow) * cardWidth;
    cardIndex += 1;
    return { i: item.i, x, y: 0, w: cardWidth, h: item.h };
  });
}

const LOBBY_CARD_LAYOUT: BalancedCardLayoutOptions = {
  minimumCardWidth: 3,
  maximumCardWidth: 5,
  maximumCardsPerRow: 2,
};

export function makeLobbyLayout(cols: number): Layout {
  return makeBalancedCardLayout(cols, LOBBY_BOXES, LOBBY_CARD_LAYOUT);
}

export const LOBBY_LAYOUTS = makeResponsiveLayouts((cols) => makeLobbyLayout(cols));
export const LOBBY_LAYOUT = LOBBY_LAYOUTS.lg!;

export const LIVE_MATCH_LAYOUTS: ResponsiveLayouts<FrontendBreakpoint> = {
  lg: [
    { i: 'overview', x: 0, y: 0, w: 12, h: 4, isBounded: false },
    { i: 'scores', x: 0, y: 1, w: 6, h: 12, minW: 2, minH: 12, isBounded: false },
    { i: 'board', x: 6, y: 1, w: 6, h: 52, minW: 2, minH: 18, isBounded: false },
    { i: 'visit', x: 0, y: 2, w: 6, h: 20, minW: 2, minH: 8, isBounded: false },
    { i: 'mode-panel', x: 0, y: 3, w: 6, h: 20, minW: 2, minH: 6, isBounded: false },
  ],
  md: [
    { i: 'overview', x: 0, y: 0, w: 10, h: 4, isBounded: true },
    { i: 'scores', x: 0, y: 1, w: 5, h: 12, minW: 2, minH: 12, isBounded: true },
    { i: 'board', x: 5, y: 1, w: 5, h: 31, minW: 2, minH: 18, isBounded: true },
    { i: 'visit', x: 0, y: 2, w: 5, h: 19, minW: 2, minH: 8, isBounded: true },
    { i: 'mode-panel', x: 0, y: 3, w: 10, h: 20, minW: 2, minH: 6, isBounded: true },
  ],
  sm: [
    { i: 'overview', x: 0, y: 0, w: 6, h: 4, isBounded: true },
    { i: 'scores', x: 0, y: 1, w: 3, h: 12, minW: 2, minH: 12, isBounded: true },
    { i: 'board', x: 3, y: 1, w: 3, h: 30, minW: 2, minH: 18, isBounded: true },
    { i: 'visit', x: 0, y: 2, w: 3, h: 18, minW: 2, minH: 8, isBounded: true },
    { i: 'mode-panel', x: 0, y: 3, w: 6, h: 20, minW: 2, minH: 6, isBounded: true },
  ],
  xs: [
    { i: 'overview', x: 0, y: 0, w: 4, h: 4, isBounded: true },
    { i: 'scores', x: 0, y: 1, w: 4, h: 12, minW: 2, minH: 12, isBounded: true },
    { i: 'board', x: 0, y: 2, w: 4, h: 30, minW: 2, minH: 18, isBounded: true },
    { i: 'visit', x: 0, y: 3, w: 4, h: 19, minW: 2, minH: 8, isBounded: true },
    { i: 'mode-panel', x: 0, y: 4, w: 4, h: 20, minW: 2, minH: 6, isBounded: true },
  ],
  xxs: [
    { i: 'overview', x: 0, y: 0, w: 2, h: 4, isBounded: true },
    { i: 'scores', x: 0, y: 1, w: 2, h: 12, minW: 2, minH: 12, isBounded: true },
    { i: 'board', x: 0, y: 2, w: 2, h: 24, minW: 2, minH: 18, isBounded: true },
    { i: 'visit', x: 0, y: 3, w: 2, h: 18, minW: 2, minH: 8, isBounded: true },
    { i: 'mode-panel', x: 0, y: 4, w: 2, h: 20, minW: 2, minH: 6, isBounded: true },
  ],
};

export const LIVE_MATCH_LAYOUT = LIVE_MATCH_LAYOUTS.lg!;

export const SUMMARY_MATCH_LAYOUTS: ResponsiveLayouts<FrontendBreakpoint> = {
  lg: [
    { i: 'overview', x: 0, y: 0, w: 12, h: 4, static: true },
    { i: 'result', x: 0, y: 4, w: 7, h: 20, minW: 2, minH: 8, isBounded: true },
    { i: 'match-history', x: 7, y: 4, w: 5, h: 20, minW: 2, minH: 8, isBounded: true },
    { i: 'rematch', x: 0, y: 24, w: 12, h: 14, isBounded: true },
  ],
  md: [
    { i: 'overview', x: 0, y: 0, w: 10, h: 4, static: true },
    { i: 'result', x: 0, y: 4, w: 7, h: 20, minW: 2, minH: 8, isBounded: true },
    { i: 'match-history', x: 5, y: 24, w: 5, h: 20, minW: 2, minH: 8, isBounded: true },
    { i: 'rematch', x: 0, y: 44, w: 10, h: 14, isBounded: true },
  ],
  sm: [
    { i: 'overview', x: 0, y: 0, w: 6, h: 4, static: true },
    { i: 'result', x: 0, y: 4, w: 6, h: 20, minW: 2, minH: 8, isBounded: true },
    { i: 'match-history', x: 1, y: 24, w: 5, h: 20, minW: 2, minH: 8, isBounded: true },
    { i: 'rematch', x: 0, y: 44, w: 6, h: 14, isBounded: true },
  ],
  xs: [
    { i: 'overview', x: 0, y: 0, w: 4, h: 4, static: true },
    { i: 'result', x: 0, y: 4, w: 4, h: 20, minW: 2, minH: 8, isBounded: true },
    { i: 'match-history', x: 0, y: 24, w: 4, h: 20, minW: 2, minH: 8, isBounded: true },
    { i: 'rematch', x: 0, y: 44, w: 4, h: 14, isBounded: true },
  ],
  xxs: [
    { i: 'overview', x: 0, y: 0, w: 2, h: 4, static: true },
    { i: 'result', x: 0, y: 4, w: 2, h: 20, minW: 2, minH: 8, isBounded: true },
    { i: 'match-history', x: 0, y: 24, w: 2, h: 20, minW: 2, minH: 8, isBounded: true },
    { i: 'rematch', x: 0, y: 44, w: 2, h: 14, isBounded: true },
  ],
};

export const SUMMARY_MATCH_LAYOUT = SUMMARY_MATCH_LAYOUTS.lg!;

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

function defaultsAtBreakpoint(
  defaultLayout: Layout,
  defaultLayouts: ResponsiveLayouts<FrontendBreakpoint> | undefined,
  breakpoint: FrontendBreakpoint,
  cols: number,
): Layout {
  const declared = defaultLayouts?.[breakpoint];
  if (!declared) return defaultLayout.map((item) => defaultAtBreakpoint(item, cols));

  const declaredById = defaultById(declared);
  return defaultLayout.map((item) => defaultAtBreakpoint(declaredById.get(item.i) ?? item, cols));
}

/**
 * Restores positions only. Constraints and static/editable flags always come from current code, so
 * a stale browser cannot preserve rules that no longer belong to an item.
 */
export function mergeResponsiveLayouts(
  rawLayouts: unknown,
  defaultLayout: Layout,
  activeIds: readonly string[],
  defaultLayouts?: ResponsiveLayouts<FrontendBreakpoint>,
): ResponsiveLayouts<FrontendBreakpoint> {
  const wanted = new Set(activeIds);
  const result: ResponsiveLayouts<FrontendBreakpoint> = {};
  const source = isRecord(rawLayouts) ? rawLayouts : {};

  for (const breakpoint of FRONTEND_BREAKPOINTS) {
    const cols = DEFAULT_COLS[breakpoint];
    const breakpointDefaults = defaultsAtBreakpoint(defaultLayout, defaultLayouts, breakpoint, cols);
    const defaults = defaultById(breakpointDefaults);
    const raw = source[breakpoint];

    if (!Array.isArray(raw)) {
      if (breakpoint === 'lg' || defaultLayouts?.[breakpoint]) {
        result[breakpoint] = breakpointDefaults
          .filter((item) => wanted.has(item.i))
          .map((item) => ({ ...item }));
      }
      continue;
    }

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

    for (const item of breakpointDefaults) {
      if (wanted.has(item.i) && !seen.has(item.i)) layout.push({ ...item });
    }
    result[breakpoint] = layout;
  }

  // The largest layout remains the canonical seed when no explicit responsive defaults are given.
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
  defaultLayouts?: ResponsiveLayouts<FrontendBreakpoint>,
): ResponsiveLayouts<FrontendBreakpoint> {
  try {
    const stored = parseStoredMatchLayouts(localStorage.getItem(MATCH_LAYOUT_STORAGE_KEY));
    return mergeResponsiveLayouts(stored?.profiles[profile], defaultLayout, activeIds, defaultLayouts);
  } catch {
    return mergeResponsiveLayouts(null, defaultLayout, activeIds, defaultLayouts);
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
