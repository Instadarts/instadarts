// Browser-only component fixture, imported through Vite by visit-layout.spec.ts.
import { MantineProvider } from '@mantine/core';
import { createRoot } from 'react-dom/client';
import { VisitInput } from '../../src/client/components/VisitInput';
import { CameraIcon } from '../../src/client/components/AppIcons';
import { appCssVariables, appTheme } from '../../src/client/layout/appTheme';
import type { ViewText } from '../../src/shared/types';

export interface VisitFixtureOptions {
  width?: number;
  height?: number;
  count?: number;
  thrown?: number;
  evidence?: (string | undefined)[] | null;
  slots?: ViewText[];
  footer?: boolean;
  scheme?: 'dark' | 'light';
}

declare global {
  interface Window {
    renderVisitFixture: (options: VisitFixtureOptions) => void;
  }
}

const host = document.createElement('div');
host.style.cssText = 'position:fixed;inset:0;z-index:1000;background:var(--instadarts-app-bg);overflow:auto';
document.body.append(host);
const root = createRoot(host);
window.renderVisitFixture = ({ width = 600, height = 300, count = 3, thrown = 0, evidence = null, slots, footer = true, scheme = 'dark' }) => {
  root.render(
    <MantineProvider theme={appTheme} cssVariablesResolver={appCssVariables} forceColorScheme={scheme}>
      <div data-testid="visit-fixture" style={{ width, height, overflow: 'auto', background: 'var(--instadarts-surface)' }}>
        <VisitInput
          darts={Array.from({ length: thrown }, () => ({ x: 0, y: 0, score: { label: 'T20', points: 60, mult: 3, base: 20 } }))}
          dartsPerVisit={count}
          slots={slots}
          visitTotal={footer ? '180' : ''}
          hideActions={!footer}
          evidence={evidence}
          onUndoDart={() => window.renderVisitFixture({ width, height, count, thrown: Math.max(0, thrown - 1), evidence: evidence?.slice(0, -1), slots, footer, scheme })}
          onSubmit={() => {}}
        />
      </div>
      <span data-testid="top-camera"><CameraIcon /></span>
    </MantineProvider>,
  );
};
