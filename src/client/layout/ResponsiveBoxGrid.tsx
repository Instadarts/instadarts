import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_BREAKPOINTS,
  DEFAULT_COLS,
  Responsive,
  findOrGenerateResponsiveLayout,
  getBreakpointFromWidth,
  getCompactor,
  useContainerWidth,
  type Layout,
  type ResponsiveLayouts,
} from 'react-grid-layout';
import { useLayoutEditor } from './LayoutEditorContext';
import {
  FRONTEND_BREAKPOINTS,
  mergeResponsiveLayouts,
  loadMatchLayouts,
  resetMatchLayout,
  saveMatchLayouts,
  type FrontendBreakpoint,
  type MatchLayoutProfile,
} from './frontendLayout';

const ROW_HEIGHT = 8;
const GAP = 12;
const COMPACTOR = getCompactor('vertical', false, true);

export interface ResponsiveBoxItem {
  id: string;
  content: ReactNode;
  autoHeight?: boolean;
}

interface ResponsiveBoxGridProps {
  items: ResponsiveBoxItem[];
  defaultLayout: Layout;
  defaultLayouts?: ResponsiveLayouts<FrontendBreakpoint>;
  profile?: MatchLayoutProfile;
  className?: string;
}

function sameLayouts(a: ResponsiveLayouts<FrontendBreakpoint>, b: ResponsiveLayouts<FrontendBreakpoint>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Materialize RGL's automatically generated layouts so auto-height can update them immediately. */
function completeResponsiveLayouts(
  layouts: ResponsiveLayouts<FrontendBreakpoint>,
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
      COMPACTOR,
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
  defaultLayout,
  defaultLayouts,
  profile,
  className = '',
}: ResponsiveBoxGridProps) {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const editor = useLayoutEditor();
  const breakpoint = getBreakpointFromWidth(DEFAULT_BREAKPOINTS, width);
  const activeKey = items.map((item) => item.id).join('|');
  const activeIds = useMemo(() => activeKey.split('|').filter(Boolean), [activeKey]);
  const initialLayouts = useMemo(
    () => completeResponsiveLayouts(
      profile
        ? loadMatchLayouts(profile, defaultLayout, activeIds, defaultLayouts)
        : mergeResponsiveLayouts(null, defaultLayout, activeIds, defaultLayouts),
    ),
    // A profile/grid instance owns one canonical item set; callers key the component when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile],
  );
  const [layouts, setLayouts] = useState<ResponsiveLayouts<FrontendBreakpoint>>(initialLayouts);
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

  const commitLayouts = useCallback((next: ResponsiveLayouts<FrontendBreakpoint>) => {
    const merged = completeResponsiveLayouts(mergeResponsiveLayouts(next, defaultLayout, activeIds, defaultLayouts));
    const measured = applyMeasuredHeights(merged);
    setLayouts((current) => sameLayouts(current, measured) ? current : measured);
    if (profile) saveMatchLayouts(profile, measured);
  }, [activeKey, activeIds, applyMeasuredHeights, defaultLayout, defaultLayouts, profile]);

  const reportHeight = useCallback((id: string, height: number) => {
    if (measuredHeights.current.get(id) === height) return;
    measuredHeights.current.set(id, height);
    setLayouts((current) => {
      const measured = applyMeasuredHeights(current);
      return sameLayouts(current, measured) ? current : measured;
    });
  }, [applyMeasuredHeights]);

  const reset = useCallback(() => {
    if (!profile) return;
    resetMatchLayout(profile);
    measuredHeights.current.clear();
    setLayouts(completeResponsiveLayouts(mergeResponsiveLayouts(null, defaultLayout, activeIds, defaultLayouts)));
    setGeneration((value) => value + 1);
  }, [activeKey, activeIds, defaultLayout, defaultLayouts, profile]);

  useEffect(() => {
    setLayouts((current) => {
      const merged = completeResponsiveLayouts(mergeResponsiveLayouts(current, defaultLayout, activeIds, defaultLayouts));
      return sameLayouts(current, merged) ? current : merged;
    });
  }, [activeKey, activeIds, defaultLayout, defaultLayouts]);

  useEffect(() => {
    setLayouts((current) => {
      const measured = applyMeasuredHeights(current);
      return sameLayouts(current, measured) ? current : measured;
    });
  }, [applyMeasuredHeights]);

  useEffect(() => {
    if (!profile) return;
    return editor.register({ profile, breakpoint, reset });
  }, [breakpoint, editor.register, profile, reset]);

  return (
    <div ref={containerRef} className={`frontend-grid-host ${className}`}>
      {mounted && (
        <Responsive<FrontendBreakpoint>
          key={generation}
          width={width}
          layouts={layouts}
          rowHeight={ROW_HEIGHT}
          margin={[GAP, GAP]}
          containerPadding={[GAP, GAP]}
          compactor={COMPACTOR}
          dragConfig={{
            enabled: editable,
            bounded: true,
            handle: '.frontend-grid-drag-handle',
            cancel: 'button,input,select,textarea,a,[role="button"],[data-no-drag]',
            threshold: 4,
          }}
          resizeConfig={{ enabled: editable, handles: ['se'] }}
          onLayoutChange={(_, allLayouts) => commitLayouts(allLayouts)}
          className={editable ? 'frontend-grid frontend-grid--editing' : 'frontend-grid'}
        >
          {items.map((item) => (
            <div key={item.id} data-grid-item={item.id}>
              <MeasuredContent id={item.id} autoHeight={item.autoHeight ?? false} onHeight={reportHeight}>
                {item.content}
              </MeasuredContent>
            </div>
          ))}
        </Responsive>
      )}
    </div>
  );
}
