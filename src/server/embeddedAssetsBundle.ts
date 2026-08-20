/**
 * In standard repository runs, this is `null` (the server falls back to `CLIENT_DIR` if set,
 * or serves no client if running beside the Vite dev server).
 *
 * When bundled by `scripts/build-release.sh`, this file is temporarily replaced with the
 * Base64-encoded, gzipped JSON dictionary containing every file in `dist/client`.
 */
export const EMBEDDED_CLIENT_BUNDLE: string | null = null;
