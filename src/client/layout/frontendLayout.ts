import { DEFAULT_COLS, type DefaultBreakpoints, type Layout, type LayoutItem, type ResponsiveLayouts } from 'react-grid-layout';

export type MatchLayoutProfile = 'match-live' | 'match-summary';
export type FrontendBreakpoint = DefaultBreakpoints;

// Keep the key stable: the envelope version below is what detects and deletes stale layouts.
export const MATCH_LAYOUT_STORAGE_KEY = 'instadarts_frontend_layout_v1';
/** Incrementing this invalidates the complete browser-local match layout catalog. */
export const MATCH_LAYOUT_VERSION = 1;

export type MatchTitleBarVisibility = Partial<Record<FrontendBreakpoint, Record<string, boolean>>>;

interface StoredMatchLayouts {
  version: typeof MATCH_LAYOUT_VERSION;
  profiles: Partial<Record<MatchLayoutProfile, ResponsiveLayouts<FrontendBreakpoint>>>;
  inactive?: Partial<Record<MatchLayoutProfile, ResponsiveLayouts<FrontendBreakpoint>>>;
  titleBars?: Partial<Record<MatchLayoutProfile, MatchTitleBarVisibility>>;
}

interface MatchLayoutItemBasePreference {
  id: string;
  defaultTitleBarVisible: boolean;
}

export type MatchLayoutItemPreference = MatchLayoutItemBasePreference & ({
  optional: false;
} | {
  optional: true;
  defaultEnabled: boolean;
});

export interface MatchLayoutState {
  layouts: ResponsiveLayouts<FrontendBreakpoint>;
  inactive: ResponsiveLayouts<FrontendBreakpoint>;
  titleBars: MatchTitleBarVisibility;
}

export const FRONTEND_BREAKPOINTS: readonly FrontendBreakpoint[] = ['lg', 'md', 'sm', 'xs', 'xxs'];
const MATCH_LAYOUT_PROFILES: readonly MatchLayoutProfile[] = ['match-live', 'match-summary'];

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

const JOIN_BOXES = [{ i: 'status', h: 10 }] as const;

export const JOIN_LAYOUTS = makeResponsiveLayouts((cols, breakpoint) => (
  makeCenteredStackLayout(cols, CENTERED_PAGE_WIDTHS[breakpoint], JOIN_BOXES)
));

const LOBBY_BOXES = [
  { i: 'overview', h: 9, fullWidth: true },
  { i: 'match-settings', h: 16 },
  { i: 'players', h: 11 },
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
  maximumCardWidth: 4,
  maximumCardsPerRow: 2,
};

export function makeLobbyLayout(cols: number): Layout {
  return makeBalancedCardLayout(cols, LOBBY_BOXES, LOBBY_CARD_LAYOUT);
}

export const LOBBY_LAYOUTS = makeResponsiveLayouts((cols) => makeLobbyLayout(cols));

export const LIVE_MATCH_LAYOUTS: ResponsiveLayouts<FrontendBreakpoint> = {
  lg: [
    { i: 'overview', x: 0, y: 0, w: 12, h: 4, isBounded: false },
    { i: 'scores', x: 0, y: 4, w: 6, h: 12, minW: 2, minH: 12, isBounded: false },
    { i: 'board', x: 6, y: 4, w: 6, h: 52, minW: 2, minH: 18, isBounded: false },
    { i: 'visit', x: 0, y: 16, w: 6, h: 20, minW: 2, minH: 8, isBounded: false },
    { i: 'mode-panel', x: 0, y: 36, w: 6, h: 20, minW: 2, minH: 6, isBounded: false },
    { i: 'history', x: 0, y: 56, w: 6, h: 20, minW: 2, minH: 8, isBounded: false },
  ],
  md: [
    { i: 'overview', x: 0, y: 0, w: 10, h: 4, isBounded: true },
    { i: 'scores', x: 0, y: 4, w: 5, h: 12, minW: 2, minH: 12, isBounded: true },
    { i: 'board', x: 5, y: 4, w: 5, h: 31, minW: 2, minH: 18, isBounded: true },
    { i: 'visit', x: 0, y: 16, w: 5, h: 19, minW: 2, minH: 8, isBounded: true },
    { i: 'mode-panel', x: 0, y: 35, w: 10, h: 20, minW: 2, minH: 6, isBounded: true },
    { i: 'history', x: 0, y: 55, w: 5, h: 20, minW: 2, minH: 8, isBounded: true },
  ],
  sm: [
    { i: 'overview', x: 0, y: 0, w: 6, h: 4, isBounded: true },
    { i: 'scores', x: 0, y: 4, w: 3, h: 12, minW: 2, minH: 12, isBounded: true },
    { i: 'board', x: 3, y: 4, w: 3, h: 30, minW: 2, minH: 18, isBounded: true },
    { i: 'visit', x: 0, y: 16, w: 3, h: 18, minW: 2, minH: 8, isBounded: true },
    { i: 'mode-panel', x: 0, y: 34, w: 6, h: 20, minW: 2, minH: 6, isBounded: true },
    { i: 'history', x: 0, y: 54, w: 3, h: 20, minW: 2, minH: 8, isBounded: true },
  ],
  xs: [
    { i: 'overview', x: 0, y: 0, w: 4, h: 4, isBounded: true },
    { i: 'scores', x: 0, y: 4, w: 4, h: 12, minW: 2, minH: 12, isBounded: true },
    { i: 'board', x: 0, y: 16, w: 4, h: 30, minW: 2, minH: 18, isBounded: true },
    { i: 'visit', x: 0, y: 46, w: 4, h: 19, minW: 2, minH: 8, isBounded: true },
    { i: 'mode-panel', x: 0, y: 65, w: 4, h: 20, minW: 2, minH: 6, isBounded: true },
    { i: 'history', x: 0, y: 85, w: 4, h: 20, minW: 2, minH: 8, isBounded: true },
  ],
  xxs: [
    { i: 'overview', x: 0, y: 0, w: 2, h: 4, isBounded: true },
    { i: 'scores', x: 0, y: 4, w: 2, h: 12, minW: 2, minH: 12, isBounded: true },
    { i: 'board', x: 0, y: 16, w: 2, h: 24, minW: 2, minH: 18, isBounded: true },
    { i: 'visit', x: 0, y: 40, w: 2, h: 18, minW: 2, minH: 8, isBounded: true },
    { i: 'mode-panel', x: 0, y: 58, w: 2, h: 20, minW: 2, minH: 6, isBounded: true },
    { i: 'history', x: 0, y: 78, w: 2, h: 20, minW: 2, minH: 8, isBounded: true },
  ],
};

export const SUMMARY_MATCH_LAYOUTS: ResponsiveLayouts<FrontendBreakpoint> = {
  lg: [
    { i: 'overview', x: 0, y: 0, w: 12, h: 4, static: true },
    { i: 'result', x: 0, y: 4, w: 6, h: 12, minW: 2, minH: 8, isBounded: true },
    { i: 'match-history', x: 6, y: 4, w: 6, h: 12, minW: 2, minH: 8, isBounded: true },
    { i: 'rematch', x: 0, y: 16, w: 12, h: 14, minW: 2, minH: 8, isBounded: true },
  ],
  md: [
    { i: 'overview', x: 0, y: 0, w: 10, h: 4, static: true },
    { i: 'result', x: 0, y: 4, w: 5, h: 12, minW: 2, minH: 8, isBounded: true },
    { i: 'match-history', x: 5, y: 4, w: 5, h: 12, minW: 2, minH: 8, isBounded: true },
    { i: 'rematch', x: 0, y: 16, w: 10, h: 14, minW: 2, minH: 8, isBounded: true },
  ],
  sm: [
    { i: 'overview', x: 0, y: 0, w: 6, h: 4, static: true },
    { i: 'result', x: 0, y: 4, w: 3, h: 12, minW: 2, minH: 8, isBounded: true },
    { i: 'match-history', x: 3, y: 4, w: 3, h: 12, minW: 2, minH: 8, isBounded: true },
    { i: 'rematch', x: 0, y: 16, w: 6, h: 14, minW: 2, minH: 8, isBounded: true },
  ],
  xs: [
    { i: 'overview', x: 0, y: 0, w: 4, h: 4, static: true },
    { i: 'result', x: 0, y: 4, w: 4, h: 12, minW: 2, minH: 8, isBounded: true },
    { i: 'match-history', x: 0, y: 16, w: 4, h: 12, minW: 2, minH: 8, isBounded: true },
    { i: 'rematch', x: 0, y: 28, w: 4, h: 14, minW: 2, minH: 8, isBounded: true },
  ],
  xxs: [
    { i: 'overview', x: 0, y: 0, w: 2, h: 8, static: true },
    { i: 'result', x: 0, y: 8, w: 2, h: 12, minW: 2, minH: 8, isBounded: true },
    { i: 'match-history', x: 0, y: 20, w: 2, h: 12, minW: 2, minH: 8, isBounded: true },
    { i: 'rematch', x: 0, y: 32, w: 2, h: 18, minW: 2, minH: 8, isBounded: true },
  ],
};

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
 * The one restore loop: the first usable stored entry for each accepted id, in stored order.
 *
 * Its two callers differ only in which ids they accept — a document grid's active set, a match
 * profile's declared cards, or the optional ones among those — so what counts as a usable entry is
 * decided here and nowhere else.
 */
function restoreStoredItems(
  raw: unknown,
  defaults: Map<string, LayoutItem>,
  cols: number,
  accepts: (id: string) => boolean,
): LayoutItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: LayoutItem[] = [];

  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate.i !== 'string' || seen.has(candidate.i)) continue;
    const fallback = defaults.get(candidate.i);
    if (!fallback || !accepts(candidate.i)) continue;
    const restored = positionFor(candidate, fallback, cols);
    if (!restored) continue;
    seen.add(candidate.i);
    result.push(restored);
  }
  return result;
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

    const layout = restoreStoredItems(raw, defaults, cols, (id) => wanted.has(id));
    const seen = new Set(layout.map((item) => item.i));

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

/**
 * Every id a stored array names, including entries whose geometry is unusable.
 *
 * Enablement is a separate question from geometry: a card the user switched on is switched on even
 * if its saved position no longer validates. Deciding it from the surviving items instead would
 * read a corrupt entry as an absent one and turn an optional card off, where the same corruption on
 * a mandatory card is simply repaired to its default position.
 */
function storedIds(raw: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(raw)) return ids;
  for (const candidate of raw) {
    if (isRecord(candidate) && typeof candidate.i === 'string') ids.add(candidate.i);
  }
  return ids;
}

/**
 * Reconcile enabled and inactive match items independently at every responsive breakpoint.
 * Optional items keep their last complete LayoutItem in whichever collection currently owns them.
 */
export function reconcileMatchLayoutState(
  rawLayouts: unknown,
  rawInactive: unknown,
  defaultLayout: Layout,
  items: readonly MatchLayoutItemPreference[],
  defaultLayouts?: ResponsiveLayouts<FrontendBreakpoint>,
  rawTitleBars?: unknown,
): MatchLayoutState {
  const preferences = new Map(items.map((item) => [item.id, item]));
  const activeSource = isRecord(rawLayouts) ? rawLayouts : {};
  const inactiveSource = isRecord(rawInactive) ? rawInactive : {};
  const titleBarSource = isRecord(rawTitleBars) ? rawTitleBars : {};
  const layouts: ResponsiveLayouts<FrontendBreakpoint> = {};
  const inactive: ResponsiveLayouts<FrontendBreakpoint> = {};
  const titleBars: MatchTitleBarVisibility = {};

  for (const breakpoint of FRONTEND_BREAKPOINTS) {
    const cols = DEFAULT_COLS[breakpoint];
    const canonical = defaultsAtBreakpoint(defaultLayout, defaultLayouts, breakpoint, cols)
      .filter((item) => preferences.has(item.i));
    const defaults = defaultById(canonical);
    const storedActive = restoreStoredItems(
      activeSource[breakpoint],
      defaults,
      cols,
      (id) => preferences.has(id),
    );
    // Only an optional card can sit in the inactive pool; a mandatory one there is a stale entry.
    const storedInactive = restoreStoredItems(
      inactiveSource[breakpoint],
      defaults,
      cols,
      (id) => preferences.get(id)?.optional === true,
    );
    const storedActiveIds = storedIds(activeSource[breakpoint]);
    const storedInactiveIds = storedIds(inactiveSource[breakpoint]);
    const enabled = new Map<string, boolean>();

    for (const item of canonical) {
      const preference = preferences.get(item.i)!;
      enabled.set(
        item.i,
        !preference.optional
          || storedActiveIds.has(item.i)
          || (!storedInactiveIds.has(item.i) && preference.defaultEnabled),
      );
    }

    const activeItems = storedActive.filter((item) => enabled.get(item.i));
    const inactiveItems = storedInactive.filter((item) => enabled.get(item.i) === false);
    const placedActive = new Set(activeItems.map((item) => item.i));
    const placedInactive = new Set(inactiveItems.map((item) => item.i));

    for (const item of canonical) {
      if (enabled.get(item.i)) {
        if (!placedActive.has(item.i)) activeItems.push({ ...item });
      } else if (!placedInactive.has(item.i)) {
        inactiveItems.push({ ...item });
      }
    }

    layouts[breakpoint] = activeItems;
    inactive[breakpoint] = inactiveItems;
    const storedTitleBars = isRecord(titleBarSource[breakpoint])
      ? titleBarSource[breakpoint]
      : {};
    titleBars[breakpoint] = Object.fromEntries(canonical.map((item) => {
      const stored = storedTitleBars[item.i];
      return [
        item.i,
        typeof stored === 'boolean'
          ? stored
          : preferences.get(item.i)!.defaultTitleBarVisible,
      ];
    }));
  }

  return { layouts, inactive, titleBars };
}

/** Move one optional card between the active layout and its breakpoint-local inactive pool. */
export function setMatchLayoutItemEnabled(
  state: MatchLayoutState,
  breakpoint: FrontendBreakpoint,
  id: string,
  enabled: boolean,
): MatchLayoutState {
  const source = enabled ? state.inactive[breakpoint] : state.layouts[breakpoint];
  const item = source?.find((candidate) => candidate.i === id);
  if (!item) return state;

  const layouts = { ...state.layouts };
  const inactive = { ...state.inactive };
  if (enabled) {
    inactive[breakpoint] = (inactive[breakpoint] ?? []).filter((candidate) => candidate.i !== id);
    layouts[breakpoint] = [
      ...(layouts[breakpoint] ?? []).filter((candidate) => candidate.i !== id),
      item,
    ];
  } else {
    layouts[breakpoint] = (layouts[breakpoint] ?? []).filter((candidate) => candidate.i !== id);
    inactive[breakpoint] = [
      ...(inactive[breakpoint] ?? []).filter((candidate) => candidate.i !== id),
      item,
    ];
  }
  return { ...state, layouts, inactive };
}

/** Set one card's title-bar visibility without changing its geometry or optional-card state. */
export function setMatchTitleBarVisible(
  state: MatchLayoutState,
  breakpoint: FrontendBreakpoint,
  id: string,
  visible: boolean,
): MatchLayoutState {
  const current = state.titleBars[breakpoint];
  if (!current || !(id in current) || current[id] === visible) return state;
  return {
    ...state,
    titleBars: {
      ...state.titleBars,
      [breakpoint]: { ...current, [id]: visible },
    },
  };
}

function parseStoredProfiles(
  raw: unknown,
): Partial<Record<MatchLayoutProfile, ResponsiveLayouts<FrontendBreakpoint>>> {
  const profiles: Partial<Record<MatchLayoutProfile, ResponsiveLayouts<FrontendBreakpoint>>> = {};
  if (!isRecord(raw)) return profiles;

  for (const profile of MATCH_LAYOUT_PROFILES) {
    const candidate = raw[profile];
    if (!isRecord(candidate)) continue;
    const layouts: ResponsiveLayouts<FrontendBreakpoint> = {};
    for (const breakpoint of FRONTEND_BREAKPOINTS) {
      const layout = candidate[breakpoint];
      if (Array.isArray(layout)) layouts[breakpoint] = layout as Layout;
    }
    profiles[profile] = layouts;
  }
  return profiles;
}

function parseStoredTitleBars(
  raw: unknown,
): Partial<Record<MatchLayoutProfile, MatchTitleBarVisibility>> {
  const profiles: Partial<Record<MatchLayoutProfile, MatchTitleBarVisibility>> = {};
  if (!isRecord(raw)) return profiles;

  for (const profile of MATCH_LAYOUT_PROFILES) {
    const candidate = raw[profile];
    if (!isRecord(candidate)) continue;
    const breakpoints: MatchTitleBarVisibility = {};
    for (const breakpoint of FRONTEND_BREAKPOINTS) {
      const stored = candidate[breakpoint];
      if (!isRecord(stored)) continue;
      breakpoints[breakpoint] = Object.fromEntries(
        Object.entries(stored).filter((entry): entry is [string, boolean] => (
          typeof entry[1] === 'boolean'
        )),
      );
    }
    profiles[profile] = breakpoints;
  }
  return profiles;
}

export function parseStoredMatchLayouts(raw: string | null): StoredMatchLayouts | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== MATCH_LAYOUT_VERSION || !isRecord(value.profiles)) return null;

    const profiles = parseStoredProfiles(value.profiles);
    const inactive = parseStoredProfiles(value.inactive);
    const titleBars = parseStoredTitleBars(value.titleBars);
    return {
      version: MATCH_LAYOUT_VERSION,
      profiles,
      ...(Object.keys(inactive).length > 0 ? { inactive } : {}),
      ...(Object.keys(titleBars).length > 0 ? { titleBars } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Read the current storage envelope. A version change deliberately invalidates the complete
 * browser-local layout catalog: discard it now so all profiles load their current defaults.
 */
function readStoredMatchLayouts(): StoredMatchLayouts | null {
  const raw = localStorage.getItem(MATCH_LAYOUT_STORAGE_KEY);
  if (!raw) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value) && value.version !== MATCH_LAYOUT_VERSION) {
      localStorage.removeItem(MATCH_LAYOUT_STORAGE_KEY);
      return null;
    }
  } catch {
    return null;
  }

  return parseStoredMatchLayouts(raw);
}

export function loadMatchLayoutState(
  profile: MatchLayoutProfile,
  defaultLayout: Layout,
  items: readonly MatchLayoutItemPreference[],
  defaultLayouts?: ResponsiveLayouts<FrontendBreakpoint>,
): MatchLayoutState {
  try {
    const stored = readStoredMatchLayouts();
    return reconcileMatchLayoutState(
      stored?.profiles[profile],
      stored?.inactive?.[profile],
      defaultLayout,
      items,
      defaultLayouts,
      stored?.titleBars?.[profile],
    );
  } catch {
    return reconcileMatchLayoutState(null, null, defaultLayout, items, defaultLayouts);
  }
}

/** Ids the state being saved has an opinion about, in either collection, at one breakpoint. */
function mentionedIds(state: MatchLayoutState, breakpoint: FrontendBreakpoint): Set<string> {
  const ids = new Set<string>();
  for (const item of state.layouts[breakpoint] ?? []) ids.add(item.i);
  for (const item of state.inactive[breakpoint] ?? []) ids.add(item.i);
  return ids;
}

/** Keep stored entries for cards the state being saved knows nothing about — see `saveMatchLayoutState`. */
function withDormantItems(
  previous: ResponsiveLayouts<FrontendBreakpoint> | undefined,
  next: ResponsiveLayouts<FrontendBreakpoint>,
  state: MatchLayoutState,
): ResponsiveLayouts<FrontendBreakpoint> {
  const merged: ResponsiveLayouts<FrontendBreakpoint> = {};

  for (const breakpoint of FRONTEND_BREAKPOINTS) {
    const mentioned = mentionedIds(state, breakpoint);
    const dormant = (previous?.[breakpoint] ?? []).filter((item) => (
      typeof item.i === 'string' && !mentioned.has(item.i)
    ));
    const current = next[breakpoint];
    if (!current && dormant.length === 0) continue;
    merged[breakpoint] = [...(current ?? []), ...dormant];
  }
  return merged;
}

/** The same, for the title bar map: current answers win, unknown ids survive. */
function withDormantTitleBars(
  previous: MatchTitleBarVisibility | undefined,
  state: MatchLayoutState,
): MatchTitleBarVisibility {
  const merged: MatchTitleBarVisibility = {};

  for (const breakpoint of FRONTEND_BREAKPOINTS) {
    const current = state.titleBars[breakpoint];
    const stored = previous?.[breakpoint];
    if (!current && !stored) continue;
    merged[breakpoint] = { ...stored, ...current };
  }
  return merged;
}

/**
 * Write one profile without discarding what it currently has no opinion about.
 *
 * A card can be temporarily absent — `mode-panel` when the mode draws none, `rematch` while
 * spectating or after somebody departs — and an absent card is absent from `itemPreferences` too, so
 * the state being saved simply never mentions it. Replacing the profile wholesale would read that
 * silence as a decision and delete the position and title bar the user chose for it. Only ids the
 * state does mention are overwritten; an id retired from the code lingers in storage until the
 * version bump, which costs nothing because loading validates against the current card set anyway.
 */
export function saveMatchLayoutState(profile: MatchLayoutProfile, state: MatchLayoutState): void {
  try {
    const previous = readStoredMatchLayouts();
    const stored: StoredMatchLayouts = {
      version: MATCH_LAYOUT_VERSION,
      profiles: {
        ...previous?.profiles,
        [profile]: withDormantItems(previous?.profiles[profile], state.layouts, state),
      },
      inactive: {
        ...previous?.inactive,
        [profile]: withDormantItems(previous?.inactive?.[profile], state.inactive, state),
      },
      titleBars: {
        ...previous?.titleBars,
        [profile]: withDormantTitleBars(previous?.titleBars?.[profile], state),
      },
    };
    localStorage.setItem(MATCH_LAYOUT_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // A layout preference must never prevent the match from rendering.
  }
}

export function resetMatchLayout(profile: MatchLayoutProfile): void {
  try {
    const previous = readStoredMatchLayouts();
    if (!previous) return;
    const profiles = { ...previous.profiles };
    const inactive = { ...previous.inactive };
    const titleBars = { ...previous.titleBars };
    delete profiles[profile];
    delete inactive[profile];
    delete titleBars[profile];
    localStorage.setItem(MATCH_LAYOUT_STORAGE_KEY, JSON.stringify({
      version: MATCH_LAYOUT_VERSION,
      profiles,
      ...(Object.keys(inactive).length > 0 ? { inactive } : {}),
      ...(Object.keys(titleBars).length > 0 ? { titleBars } : {}),
    }));
  } catch {
    // The in-memory layout is reset by the caller either way.
  }
}
