// Every game mode the server knows about.
//
// Importing a mode file is what installs it: each one calls registerMode() at the top level. A mode
// missing from this list is never loaded, however complete its file is.

import './x01.js';
import './whac-a-mole.js';
