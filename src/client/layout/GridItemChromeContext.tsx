import { createContext, useContext, type ReactNode } from 'react';

interface GridItemChromeValue {
  titleBarVisible: boolean;
  setTitleBarVisible?: (visible: boolean) => void;
}

const GridItemChromeContext = createContext<GridItemChromeValue | null>(null);

export function GridItemChromeProvider({
  titleBarVisible,
  setTitleBarVisible,
  children,
}: GridItemChromeValue & { children: ReactNode }) {
  return (
    <GridItemChromeContext.Provider value={{ titleBarVisible, setTitleBarVisible }}>
      {children}
    </GridItemChromeContext.Provider>
  );
}

export function useGridItemChrome(): GridItemChromeValue | null {
  return useContext(GridItemChromeContext);
}
