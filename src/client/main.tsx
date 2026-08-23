import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { MantineProvider } from '@mantine/core';
import { App } from './App';
import { ScorerApp } from './ScorerApp';
import { LayoutEditorProvider } from './layout/LayoutEditorContext';
import { appTheme } from './layout/appTheme';
import { applyAppZoom, loadAppZoom } from './layout/appZoom';
import '@mantine/core/styles.css';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './index.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);
const scorer = window.location.pathname.startsWith('/scorer');
document.documentElement.dataset.app = scorer ? 'scorer' : 'frontend';
const zoomTarget = scorer ? 'scorer' : 'frontend';
applyAppZoom(zoomTarget, loadAppZoom(zoomTarget));

// The scoring device is a sibling of the gaming frontend, not a route inside it: it must not share
// App's socket, its match state or its navigation effects (which would bounce it straight home).
// It is also mounted outside StrictMode, because the vision runtime it grows in phase 5 owns a
// camera stream and a motion detector, and a double mount would start two of each.
if (scorer) {
  root.render(
    <MantineProvider theme={appTheme} forceColorScheme="dark">
      <ScorerApp />
    </MantineProvider>,
  );
} else {
  root.render(
    <MantineProvider theme={appTheme} forceColorScheme="dark">
      <React.StrictMode>
        <LayoutEditorProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </LayoutEditorProvider>
      </React.StrictMode>
    </MantineProvider>,
  );
}
