// Every game mode the server knows about.
//
// Importing a mode file is what installs it: each one calls registerMode() at the top level. A mode
// missing from this list is never loaded, however complete its file is.

import { IS_DEV } from '../env.js';
import './x01.js';
import './whac-a-mole.js';

if (IS_DEV) {
  await import('./count-up.js');
}
