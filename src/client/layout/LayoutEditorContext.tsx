import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FrontendBreakpoint, MatchLayoutProfile } from './frontendLayout';

interface ActiveLayoutEditor {
  profile: MatchLayoutProfile;
  breakpoint: FrontendBreakpoint;
  reset: () => void;
}

interface LayoutEditorValue {
  active: ActiveLayoutEditor | null;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  register: (editor: ActiveLayoutEditor) => () => void;
  reset: () => void;
}

const LayoutEditorContext = createContext<LayoutEditorValue | null>(null);

export function LayoutEditorProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveLayoutEditor | null>(null);
  const [editing, setEditing] = useState(false);
  const registration = useRef<{ token: symbol; profile: MatchLayoutProfile } | null>(null);

  const register = useCallback((editor: ActiveLayoutEditor) => {
    const mine = Symbol(editor.profile);
    if (registration.current && registration.current.profile !== editor.profile) setEditing(false);
    registration.current = { token: mine, profile: editor.profile };
    setActive(editor);
    return () => {
      // A breakpoint update cleans up and re-registers this effect in the same React pass. Waiting
      // for the microtask lets that replacement claim the context without flicking edit mode off.
      queueMicrotask(() => {
        if (registration.current?.token !== mine) return;
        registration.current = null;
        setActive(null);
        setEditing(false);
      });
    };
  }, []);

  const reset = useCallback(() => {
    active?.reset();
    setEditing(false);
  }, [active]);

  const value = useMemo(
    () => ({ active, editing, setEditing, register, reset }),
    [active, editing, register, reset],
  );

  return <LayoutEditorContext.Provider value={value}>{children}</LayoutEditorContext.Provider>;
}

export function useLayoutEditor(): LayoutEditorValue {
  const value = useContext(LayoutEditorContext);
  if (!value) throw new Error('useLayoutEditor must be used inside LayoutEditorProvider');
  return value;
}
