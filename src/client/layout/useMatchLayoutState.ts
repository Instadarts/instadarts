import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { Layout, ResponsiveLayouts } from 'react-grid-layout';
import {
  FRONTEND_BREAKPOINTS,
  loadMatchLayoutState,
  reconcileMatchLayoutState,
  resetMatchLayout,
  saveMatchLayoutState,
  setMatchLayoutItemEnabled,
  type FrontendBreakpoint,
  type MatchLayoutItemPreference,
  type MatchLayoutProfile,
  type MatchLayoutState,
} from './frontendLayout';

function sameLayouts(
  a: ResponsiveLayouts<FrontendBreakpoint>,
  b: ResponsiveLayouts<FrontendBreakpoint>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameMatchLayoutState(a: MatchLayoutState, b: MatchLayoutState): boolean {
  return sameLayouts(a.layouts, b.layouts) && sameLayouts(a.inactive, b.inactive);
}

/** RGL owns active-item geometry; only the optional-card controls own active-item membership. */
function reportedLayoutsWithCurrentMembership(
  reported: ResponsiveLayouts<FrontendBreakpoint>,
  current: ResponsiveLayouts<FrontendBreakpoint>,
): ResponsiveLayouts<FrontendBreakpoint> {
  const result: ResponsiveLayouts<FrontendBreakpoint> = {};
  for (const breakpoint of FRONTEND_BREAKPOINTS) {
    const currentLayout = current[breakpoint] ?? [];
    const currentIds = new Set(currentLayout.map((item) => item.i));
    const next = (reported[breakpoint] ?? []).filter((item) => currentIds.has(item.i));
    const reportedIds = new Set(next.map((item) => item.i));
    for (const item of currentLayout) {
      if (!reportedIds.has(item.i)) next.push(item);
    }
    result[breakpoint] = next;
  }
  return result;
}

interface ManagedMatchLayoutState {
  value: MatchLayoutState;
  persistenceRevision: number;
}

interface UpdateAction {
  update: (current: MatchLayoutState) => MatchLayoutState;
  persist: boolean;
}

function reducer(
  current: ManagedMatchLayoutState | null,
  action: UpdateAction,
): ManagedMatchLayoutState | null {
  if (!current) return current;
  const next = action.update(current.value);
  if (sameMatchLayoutState(current.value, next)) return current;
  return {
    value: next,
    persistenceRevision: current.persistenceRevision + (action.persist ? 1 : 0),
  };
}

interface UseMatchLayoutStateOptions {
  profile?: MatchLayoutProfile;
  defaultLayout: Layout;
  defaultLayouts: ResponsiveLayouts<FrontendBreakpoint>;
  itemPreferences: readonly MatchLayoutItemPreference[];
  normalizeLayouts: (
    layouts: ResponsiveLayouts<FrontendBreakpoint>,
  ) => ResponsiveLayouts<FrontendBreakpoint>;
}

/** Owns validation, optional-card membership, persistence, and reset for one match profile. */
export function useMatchLayoutState({
  profile,
  defaultLayout,
  defaultLayouts,
  itemPreferences,
  normalizeLayouts,
}: UseMatchLayoutStateOptions) {
  const [managed, dispatch] = useReducer(reducer, null, () => (
    profile ? {
      value: loadMatchLayoutState(profile, defaultLayout, itemPreferences, defaultLayouts),
      persistenceRevision: 0,
    } : null
  ));
  const persistedRevision = useRef(0);
  const optionalIds = useMemo(
    () => new Set(itemPreferences.filter((item) => item.optional).map((item) => item.id)),
    [itemPreferences],
  );

  useEffect(() => {
    if (!profile || !managed) return;
    if (managed.persistenceRevision === persistedRevision.current) return;
    saveMatchLayoutState(profile, managed.value);
    persistedRevision.current = managed.persistenceRevision;
  }, [managed, profile]);

  useEffect(() => {
    if (!profile) return;
    dispatch({
      persist: false,
      update: (current) => reconcileMatchLayoutState(
        current.layouts,
        current.inactive,
        defaultLayout,
        itemPreferences,
        defaultLayouts,
      ),
    });
  }, [defaultLayout, defaultLayouts, itemPreferences, profile]);

  const commitLayouts = useCallback((reported: ResponsiveLayouts<FrontendBreakpoint>) => {
    if (!profile) return;
    dispatch({
      persist: true,
      update: (current) => {
        const activeLayouts = reportedLayoutsWithCurrentMembership(reported, current.layouts);
        const reconciled = reconcileMatchLayoutState(
          activeLayouts,
          current.inactive,
          defaultLayout,
          itemPreferences,
          defaultLayouts,
        );
        return { ...reconciled, layouts: normalizeLayouts(reconciled.layouts) };
      },
    });
  }, [defaultLayout, defaultLayouts, itemPreferences, normalizeLayouts, profile]);

  const updateLayouts = useCallback((
    update: (
      layouts: ResponsiveLayouts<FrontendBreakpoint>,
    ) => ResponsiveLayouts<FrontendBreakpoint>,
  ) => {
    if (!profile) return;
    dispatch({
      persist: false,
      update: (current) => ({ ...current, layouts: update(current.layouts) }),
    });
  }, [profile]);

  const setItemEnabled = useCallback((
    breakpoint: FrontendBreakpoint,
    id: string,
    enabled: boolean,
  ) => {
    if (!profile || !optionalIds.has(id)) return;
    dispatch({
      persist: true,
      update: (current) => setMatchLayoutItemEnabled(current, breakpoint, id, enabled),
    });
  }, [optionalIds, profile]);

  const reset = useCallback(() => {
    if (!profile) return;
    resetMatchLayout(profile);
    dispatch({
      persist: false,
      update: () => reconcileMatchLayoutState(
        null,
        null,
        defaultLayout,
        itemPreferences,
        defaultLayouts,
      ),
    });
  }, [defaultLayout, defaultLayouts, itemPreferences, profile]);

  return {
    state: managed?.value ?? null,
    commitLayouts,
    reset,
    setItemEnabled,
    updateLayouts,
  };
}
