import { createContext, useContext, type ReactNode } from 'react';

interface GridItemLayoutValue {
  /** Current width of this card in React Grid Layout columns. */
  widthUnits: number;
}

const GridItemLayoutContext = createContext<GridItemLayoutValue | null>(null);

export function GridItemLayoutProvider({
  widthUnits,
  children,
}: GridItemLayoutValue & { children: ReactNode }) {
  return (
    <GridItemLayoutContext.Provider value={{ widthUnits }}>
      {children}
    </GridItemLayoutContext.Provider>
  );
}

/** Grid-unit geometry of the card containing this component, or null outside a grid card. */
export function useGridItemLayout(): GridItemLayoutValue | null {
  return useContext(GridItemLayoutContext);
}
