import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_BREAKPOINTS,
  DEFAULT_COLS,
  Responsive,
  findOrGenerateResponsiveLayout,
  getBreakpointFromWidth,
  getCompactor,
  useContainerWidth,
  type Compactor,
  type ResponsiveLayouts,
} from 'react-grid-layout';
import { useLayoutEditor } from './LayoutEditorContext';
import {
  FRONTEND_BREAKPOINTS,
  mergeResponsiveLayouts,
  type FrontendBreakpoint,
  type MatchLayoutProfile,
} from './frontendLayout';
import { GridItemChromeProvider } from './GridItemChromeContext';
import { useMatchLayoutState } from './useMatchLayoutState';

const ROW_HEIGHT = 8;
const GAP = 12;
const DOCUMENT_COMPACTOR = getCompactor('vertical', false, true);
const MATCH_COMPACTOR = getCompactor('vertical', true, false);

export interface ResponsiveBoxItem {
  id: string;
  content: ReactNode;
  autoHeight?: boolean;
  defaultTitleBarVisible?: boolean;
  optional?: {
    label: string;
    defaultEnabled: boolean;
  };
}

interface ResponsiveBoxGridProps {
  items: ResponsiveBoxItem[];
  defaultLayouts: ResponsiveLayouts<FrontendBreakpoint>;
  profile?: MatchLayoutProfile;
}

function sameLayouts(a: ResponsiveLayouts<FrontendBreakpoint>, b: ResponsiveLayouts<FrontendBreakpoint>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Materialize RGL's automatically generated layouts so auto-height can update them immediately. */
function completeResponsiveLayouts(
  layouts: ResponsiveLayouts<FrontendBreakpoint>,
  compactor: Compactor,
): ResponsiveLayouts<FrontendBreakpoint> {
  const complete = { ...layouts };
  for (const breakpoint of FRONTEND_BREAKPOINTS) {
    if (complete[breakpoint]) continue;
    complete[breakpoint] = findOrGenerateResponsiveLayout(
      complete,
      DEFAULT_BREAKPOINTS,
      breakpoint,
      breakpoint,
      DEFAULT_COLS[breakpoint],
      compactor,
    );
  }
  return complete;
}

function rowsForHeight(height: number): number {
  return Math.max(1, Math.ceil((height + GAP) / (ROW_HEIGHT + GAP)));
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Natural card height, independent of the grid item height the card is stretched to fill. */
function intrinsicBoxHeight(host: HTMLElement): number {
  const card = host.firstElementChild;
  if (!(card instanceof HTMLElement)) return host.scrollHeight;
  const body = card.querySelector<HTMLElement>('.frontend-grid-box__body');
  const content = card.querySelector<HTMLElement>('[data-grid-box-content]');
  if (!body || !content) return card.scrollHeight;

  const bodyStyle = getComputedStyle(body);
  const cardStyle = getComputedStyle(card);
  const chromeHeight = Array.from(card.children).reduce((height, child) => (
    child === body ? height : height + child.getBoundingClientRect().height
  ), 0);
  const contentHeight = Math.max(content.scrollHeight, content.getBoundingClientRect().height);

  return Math.ceil(
    chromeHeight
    + contentHeight
    + pixels(bodyStyle.paddingTop)
    + pixels(bodyStyle.paddingBottom)
    + pixels(cardStyle.borderTopWidth)
    + pixels(cardStyle.borderBottomWidth),
  );
}

function MeasuredContent({
  id,
  autoHeight,
  onHeight,
  children,
}: {
  id: string;
  autoHeight: boolean;
  onHeight: (id: string, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoHeight || !ref.current) return;
    const element = ref.current;
    const report = () => onHeight(id, intrinsicBoxHeight(element));
    report();
    const resizeObserver = new ResizeObserver(report);
    resizeObserver.observe(element);
    const content = element.querySelector('[data-grid-box-content]');
    if (content) resizeObserver.observe(content);

    // ResizeObserver only sees the observed border box. An item whose content is flex-shrunk to its
    // current RGL height can gain or lose overflowing children without changing that box at all.
    // DOM changes therefore need their own signal; reading the geometry in `report` forces the
    // browser to account for the completed mutation before converting it to grid rows.
    const mutationObserver = new MutationObserver(report);
    if (content) {
      mutationObserver.observe(content, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
      });
    }

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [autoHeight, id, onHeight]);

  return (
    <div ref={ref} className={autoHeight ? 'frontend-grid-content frontend-grid-content--auto' : 'frontend-grid-content frontend-grid-content--fixed'}>
      {children}
    </div>
  );
}

export function ResponsiveBoxGrid({
  items,
  defaultLayouts,
  profile,
}: ResponsiveBoxGridProps) {
  const defaultLayout = defaultLayouts.lg;
  if (!defaultLayout) throw new Error('ResponsiveBoxGrid requires an lg default layout');

  // The lg map is the canonical card set: everything downstream of it derives from that map rather
  // than from `items`, so an item missing an entry would render nowhere in a match grid and land
  // wherever RGL chose in a document one. Say so, the way the missing map above already does.
  const orphan = items.find((item) => !defaultLayout.some((placed) => placed.i === item.id));
  if (orphan) throw new Error(`ResponsiveBoxGrid item "${orphan.id}" has no lg default layout`);

  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const editor = useLayoutEditor();

  // A profile/grid instance owns one canonical item set and one storage slot: `useMatchLayoutState`
  // reads `profile` in a lazy initializer, once, at mount. A changed profile would therefore keep
  // the previous profile's state, never load the new one's saved layout, and overwrite it with
  // defaults on the first edit. Callers key the component by profile; this holds them to it.
  const mountProfile = useRef(profile);
  if (mountProfile.current !== profile) {
    throw new Error('ResponsiveBoxGrid must be remounted when its profile changes');
  }
  const measuredBreakpoint = getBreakpointFromWidth(DEFAULT_BREAKPOINTS, width);
  const [responsiveBreakpoint, setResponsiveBreakpoint] = useState<FrontendBreakpoint | null>(null);
  const breakpoint = responsiveBreakpoint ?? measuredBreakpoint;
  const compactor = profile ? MATCH_COMPACTOR : DOCUMENT_COMPACTOR;
  // `items` is rebuilt every render — new content, same configuration — so it cannot be a dependency.
  // These tuples are what the memo reads and their serialization is what tells it when to recompute,
  // which holds only while the two stay the same list: anything a preference depends on has to be in
  // the tuple, or the memo will not notice it changing.
  const itemConfiguration = items.map((item) => [
    item.id,
    item.optional?.label ?? null,
    item.optional?.defaultEnabled ?? null,
    item.defaultTitleBarVisible ?? true,
  ] as const);
  const itemConfigurationKey = JSON.stringify(itemConfiguration);
  const { itemPreferences, availableIds, optionalCatalog } = useMemo(() => ({
    itemPreferences: itemConfiguration.map(([
      id,
      label,
      defaultEnabled,
      defaultTitleBarVisible,
    ]) => label === null
      ? { id, optional: false as const, defaultTitleBarVisible }
      : {
          id,
          optional: true as const,
          defaultEnabled: defaultEnabled ?? true,
          defaultTitleBarVisible,
        }),
    availableIds: itemConfiguration.map(([id]) => id),
    optionalCatalog: itemConfiguration.flatMap(([id, label]) => (
      label === null ? [] : [{ id, label }]
    )),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [itemConfigurationKey]);
  const [generation, setGeneration] = useState(0);
  const measuredHeights = useRef(new Map<string, number>());
  const editable = profile !== undefined && editor.editing;

  const applyMeasuredHeights = useCallback((next: ResponsiveLayouts<FrontendBreakpoint>) => {
    const current = next[breakpoint];
    if (!current) return next;
    let changed = false;
    const adjusted = current.map((item) => {
      const measured = measuredHeights.current.get(item.i);
      if (measured === undefined) return item;
      const h = Math.max(item.minH ?? 1, rowsForHeight(measured));
      if (h === item.h) return item;
      changed = true;
      return { ...item, h };
    });
    return changed ? { ...next, [breakpoint]: adjusted } : next;
  }, [breakpoint]);

  const {
    state: matchLayoutState,
    commitLayouts: commitMatchLayouts,
    reset: resetMatchLayoutState,
    setItemEnabled: setMatchItemEnabled,
    setTitleBarVisible: setMatchTitleBarVisible,
    updateLayouts: updateMatchLayouts,
  } = useMatchLayoutState({
    profile,
    defaultLayout,
    defaultLayouts,
    itemPreferences,
    normalizeLayouts: applyMeasuredHeights,
  });
  const [documentLayouts, setDocumentLayouts] = useState<ResponsiveLayouts<FrontendBreakpoint>>(
    () => profile ? {} : completeResponsiveLayouts(
      mergeResponsiveLayouts(null, defaultLayout, availableIds, defaultLayouts),
      DOCUMENT_COMPACTOR,
    ),
  );
  const layouts = matchLayoutState?.layouts ?? documentLayouts;

  const commitLayouts = useCallback((next: ResponsiveLayouts<FrontendBreakpoint>) => {
    if (profile) {
      commitMatchLayouts(next);
    } else {
      setDocumentLayouts((current) => {
        const merged = completeResponsiveLayouts(
          mergeResponsiveLayouts(next, defaultLayout, availableIds, defaultLayouts),
          DOCUMENT_COMPACTOR,
        );
        const measured = applyMeasuredHeights(merged);
        return sameLayouts(current, measured) ? current : measured;
      });
    }
  }, [applyMeasuredHeights, availableIds, commitMatchLayouts, defaultLayout, defaultLayouts, profile]);

  const reportHeight = useCallback((id: string, height: number) => {
    if (measuredHeights.current.get(id) === height) return;
    measuredHeights.current.set(id, height);
    if (profile) {
      updateMatchLayouts(applyMeasuredHeights);
    } else {
      setDocumentLayouts((current) => {
        const measured = applyMeasuredHeights(current);
        return sameLayouts(current, measured) ? current : measured;
      });
    }
  }, [applyMeasuredHeights, profile, updateMatchLayouts]);

  const reset = useCallback(() => {
    if (!profile) return;
    measuredHeights.current.clear();
    resetMatchLayoutState();
    setGeneration((value) => value + 1);
  }, [profile, resetMatchLayoutState]);

  useEffect(() => {
    if (profile) return;
    setDocumentLayouts((current) => {
      const merged = completeResponsiveLayouts(
        mergeResponsiveLayouts(current, defaultLayout, availableIds, defaultLayouts),
        DOCUMENT_COMPACTOR,
      );
      return sameLayouts(current, merged) ? current : merged;
    });
  }, [availableIds, defaultLayout, defaultLayouts, profile]);

  useEffect(() => {
    if (profile) {
      updateMatchLayouts(applyMeasuredHeights);
    } else {
      setDocumentLayouts((current) => {
        const measured = applyMeasuredHeights(current);
        return sameLayouts(current, measured) ? current : measured;
      });
    }
  }, [applyMeasuredHeights, profile, updateMatchLayouts]);

  useEffect(() => {
    if (mounted && responsiveBreakpoint === null) setResponsiveBreakpoint(measuredBreakpoint);
  }, [measuredBreakpoint, mounted, responsiveBreakpoint]);

  const enabledItemIds = (layouts[breakpoint] ?? []).map((item) => item.i).sort();
  const enabledItemKey = JSON.stringify(enabledItemIds);
  // Same shape as above: the ids are the source, their serialization is when to rebuild the set.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const enabledIds = useMemo(() => new Set(enabledItemIds), [enabledItemKey]);
  const optionalItems = useMemo(() => optionalCatalog.map((item) => ({
    ...item,
    enabled: enabledIds.has(item.id),
  })), [enabledIds, optionalCatalog]);

  const setOptionalItemEnabled = useCallback((id: string, enabled: boolean) => {
    setMatchItemEnabled(breakpoint, id, enabled);
  }, [breakpoint, setMatchItemEnabled]);

  useEffect(() => {
    if (!profile) return;
    return editor.register({
      profile,
      breakpoint,
      optionalItems,
      setOptionalItemEnabled,
      reset,
    });
  }, [breakpoint, editor.register, optionalItems, profile, reset, setOptionalItemEnabled]);

  const renderedItems = profile
    ? items.filter((item) => enabledIds.has(item.id))
    : items;

  return (
    <div ref={containerRef} className="frontend-grid-host">
      {mounted && (
        <Responsive<FrontendBreakpoint>
          key={generation}
          width={width}
          layouts={layouts}
          rowHeight={ROW_HEIGHT}
          margin={[GAP, GAP]}
          containerPadding={[GAP, GAP]}
          compactor={compactor}
          dragConfig={{
            enabled: editable,
            bounded: true,
            handle: '.frontend-grid-drag-handle',
            cancel: 'button,input,select,textarea,a,[role="button"],[data-no-drag]',
            threshold: 4,
          }}
          resizeConfig={{ enabled: editable, handles: ['se'] }}
          onBreakpointChange={setResponsiveBreakpoint}
          onLayoutChange={(_, allLayouts) => commitLayouts(allLayouts)}
          className={editable ? 'frontend-grid frontend-grid--editing' : 'frontend-grid'}
        >
          {renderedItems.map((item) => {
            const titleBarVisible = matchLayoutState?.titleBars[breakpoint]?.[item.id]
              ?? item.defaultTitleBarVisible
              ?? true;
            return (
              <div key={item.id} data-grid-item={item.id}>
                <GridItemChromeProvider
                  titleBarVisible={titleBarVisible}
                  {...(profile ? {
                    setTitleBarVisible: (visible: boolean) => (
                      setMatchTitleBarVisible(breakpoint, item.id, visible)
                    ),
                  } : {})}
                >
                  <MeasuredContent id={item.id} autoHeight={item.autoHeight ?? false} onHeight={reportHeight}>
                    {item.content}
                  </MeasuredContent>
                </GridItemChromeProvider>
              </div>
            );
          })}
        </Responsive>
      )}
    </div>
  );
}
