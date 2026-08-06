import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { ScorerApp } from './ScorerApp';
import './index.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);

// The scoring device is a sibling of the gaming frontend, not a route inside it: it must not share
// App's socket, its match state or its navigation effects (which would bounce it straight home).
// It is also mounted outside StrictMode, because the vision runtime it grows in phase 5 owns a
// camera stream and a motion detector, and a double mount would start two of each.
if (window.location.pathname.startsWith('/scorer')) {
  root.render(<ScorerApp />);
} else {
  root.render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  );
}
