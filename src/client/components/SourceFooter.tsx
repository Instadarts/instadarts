// Where this app's source is, said in the app itself.
//
// **This is a licence obligation, not decoration.** InstaDarts is under the GNU AGPL v3, whose §13
// is the clause that distinguishes it from the plain GPL: anyone who modifies it and lets people
// use it over a network has to offer those users the corresponding source. Both frontends are
// exactly that — something people use over a network — so the offer belongs in both, and a
// deployment that modified the app inherits a working mechanism instead of having to invent one.
//
// So: do not remove this to save a line of vertical space, and do not make it conditional on a
// route or a build. If it needs to move, it moves; it does not go away.

/**
 * The repository. The organisation root rather than a repository under it — deliberately, because
 * a URL that is right the day the first repository appears and stays right when it is renamed is
 * worth more here than one extra path segment.
 */
export const SOURCE_URL = 'https://github.com/Instadarts';

/**
 * One quiet line at the bottom of a frontend.
 *
 * `shrink-0` because both shells are flex columns whose middle is `flex-1`: without it a screen
 * asking to fill the height would compress this instead of yielding the space it actually has.
 *
 * `target="_blank"` matters more than it looks. The scoring device is a phone mounted on a wall
 * watching a board, and navigating that away mid-match — losing the socket, the camera and the
 * pairing — because somebody brushed the bottom of the screen would be a genuinely bad outcome.
 */
export function SourceFooter() {
  return (
    <footer className="shrink-0 py-0 text-center text-[11px]">
      <a
        href={SOURCE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] text-gray-600 hover:text-gray-400 transition-colors"
      >
        Source code (AGPL-3.0)
      </a>
    </footer>
  );
}
