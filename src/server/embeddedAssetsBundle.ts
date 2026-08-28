/**
 * In standard repository runs, this is `null` (the server falls back to `CLIENT_DIR` if set, or to
 * the Vite dev client when `DEV_CLIENT` asks for one, or serves no client at all).
 *
 * When bundled by `scripts/build-mjs.sh`, this file is temporarily replaced with the
 * Base64-encoded, gzipped JSON dictionary containing every file in `dist/client`.
 */
export const EMBEDDED_CLIENT_BUNDLE: string | null = null;
