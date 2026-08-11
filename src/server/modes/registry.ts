// Every game mode the server knows about.  Add new modes here — their
// top-level registerMode() call is what makes them available at runtime.
//
// This file exists because pkg bundles the server into a single executable
// where dynamic filesystem scanning (what loadModes used to do) cannot work.
// Vite's import.meta.glob handles the client-side panels the same way.

import './x01.js';
