/**
 * Where the project itself lives.
 *
 * The home page's help card names three places in the repository and the settings menu names a
 * fourth. One module for all of them, so a move or a rename is a single edit rather than a hunt
 * through components, and so a link that has quietly rotted is visible next to the ones that work.
 */
const REPOSITORY_URL = 'https://github.com/instadarts/instadarts';

export const PROJECT_LINKS = {
  /** The organisation rather than the repository: what the settings menu has always pointed at. */
  organisation: 'https://github.com/Instadarts',
  /** The repository home, which renders the README: setup, first game, and self-hosting. */
  readme: REPOSITORY_URL,
  issues: `${REPOSITORY_URL}/issues`,
  /** The blob URL rather than the repository root, so the file opens rendered on the default branch. */
  contributing: `${REPOSITORY_URL}/blob/main/CONTRIBUTING.md`,
} as const;
