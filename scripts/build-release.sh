#!/usr/bin/env bash
# Build the release archive: everything somebody needs to run InstaDarts, and nothing else.
#
#   ./scripts/build-release.sh [version]
#
# Produces release/instadarts-<version>.zip containing:
#
#   instadarts.mjs                  the whole server + frontend, dependencies inlined
#   instadarts.config.example.jsonc every setting, at its default
#   LICENSE                         ours: the GNU AGPL v3
#   THIRD-PARTY-NOTICES.txt         what the bundled licences ask us to carry
#   README.md
#
# What the reader has to do with that is install Node and run `node instadarts.mjs`. **No npm
# install**, no node_modules, no network after the download — which is the whole point, because
# the person this is for did not come here to learn npm.
#
# One archive for every platform, because it is pure JavaScript. Nothing here is compiled per-OS
# and no runtime is redistributed.

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(node -p "require('./package.json').version")}"
OUT="release"
STAGE="$OUT/instadarts-$VERSION"

rm -rf "$OUT" && mkdir -p "$STAGE"

# ── 1. The client ────────────────────────────────────────────────────

echo "=== Building client ==="
npx vite build

echo "=== Packaging embedded client ==="
node scripts/bundle-client.mjs dist/client src/server/embeddedAssetsBundle.ts

cleanup() {
  cat << 'EOF' > src/server/embeddedAssetsBundle.ts
/**
 * In standard repository runs, this is `null` (the server falls back to `CLIENT_DIR` if set,
 * or serves no client if running beside the Vite dev server).
 *
 * When bundled by `scripts/build-release.sh`, this file is temporarily replaced with the
 * Base64-encoded, gzipped JSON dictionary containing every file in `dist/client`.
 */
export const EMBEDDED_CLIENT_BUNDLE: string | null = null;
EOF
}
trap cleanup EXIT

# ── 2. The server, as one file ───────────────────────────────────────
#    esbuild strips the TypeScript and inlines express, ws, and the
#    embedded client assets, so the archive needs no dependencies or
#    external static files of its own.
#
#    The banner is the file's first act: enforce minimum Node.js version
#    and establish the runtime root directory.
#
#    INSTADARTS_DIR names the directory beside this file, so the settings
#    can sit next to the thing they configure whichever directory it is
#    started from. A directory rather than a path, because the file has
#    two accepted names and picking one here would rule out the other.
#    It is a place to look and not a demand: nothing there means the
#    working directory is tried next, exactly as without it.

NODE_MAJOR="$(node --version | cut -d. -f1 | tr -d v)"

banner="const [__nodeMajor] = (process.versions.node || '').split('.').map(Number);"
banner+="if (!__nodeMajor || __nodeMajor < 22) { console.error('InstaDarts requires Node.js 22 or later (currently running on Node.js ' + (process.version || 'unknown') + ').'); process.exit(1); }"
banner+="import { fileURLToPath as __toPath } from 'node:url';"
banner+="import { dirname as __dir } from 'node:path';"
banner+="import { createRequire as __createRequire } from 'node:module';"
# express reaches `debug`, which does `require('tty')` at load time. Bundled to ESM there is no
# `require` for it to reach, and esbuild's shim throws rather than guessing — so give it one.
# esbuild's shim uses a `require` it can see, and this declares it above the shim's own line.
banner+="const require = __createRequire(import.meta.url);"
banner+="const __here = __dir(__toPath(import.meta.url));"
banner+="process.env.NODE_ENV = 'production';"
banner+="process.env.INSTADARTS_DIR = process.env.INSTADARTS_DIR ?? __here;"

echo "=== Bundling server ==="
npx esbuild src/server/index.ts \
  --bundle \
  --platform=node \
  --target="node${NODE_MAJOR}" \
  --format=esm \
  --banner:js="$banner" \
  --metafile="$OUT/server-meta.json" \
  --outfile="$STAGE/instadarts.mjs"

# ── 3. What the licences ask for — ours first ────────────────────────
#    The AGPL asks that a copy travel with every conveyed copy of the
#    program, so this is a condition of distributing the archive at all
#    rather than a courtesy. Fail loudly: an archive without it is one
#    we had no right to hand out.

if [ ! -f LICENSE ]; then
  echo "!!! no LICENSE — refusing to build an archive we may not distribute" >&2
  exit 1
fi
cp LICENSE "$STAGE/"

#    Then everyone else's. The archive carries other people's code —
#    express and ws inside the .mjs, React and LiteRT inside client/ —
#    and every licence involved asks for its notice to travel with it.
#    Generated from the metafile above, so it cannot fall behind what
#    was actually bundled.

echo "=== Third-party notices ==="
node scripts/third-party-notices.mjs "$OUT/server-meta.json" "$STAGE/THIRD-PARTY-NOTICES.txt"

# ── 4. What the reader reads ─────────────────────────────────────────

cp instadarts.config.example.jsonc "$STAGE/"
if [ -f README.md ]; then
  cp README.md "$STAGE/"
else
  echo "!!! no README.md — the archive will ship without one"
fi

# ── 5. The archive ───────────────────────────────────────────────────

# A .zip rather than a .tar.gz, because Windows opens one by double-clicking and needs a program
# for the other. `zip` where it exists, Python's zipfile where it does not — the archive is the
# same either way, so a release built on a machine without zip(1) is not a different release.
if command -v zip > /dev/null; then
  ( cd "$OUT" && zip -qr "instadarts-$VERSION.zip" "instadarts-$VERSION" )
else
  python3 - "$OUT" "instadarts-$VERSION" << 'PY'
import pathlib, sys, zipfile
out, name = pathlib.Path(sys.argv[1]), sys.argv[2]
with zipfile.ZipFile(out / f"{name}.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for path in sorted((out / name).rglob("*")):
        if path.is_file():
            z.write(path, path.relative_to(out))
PY
fi

echo ""
echo "=== Done ==="
ls -lh "$OUT/instadarts-$VERSION.zip"
