#!/usr/bin/env bash
# Build the release archive: everything somebody needs to run InstaDarts, and nothing else.
#
#   ./scripts/build-release.sh [version]
#
# Produces release/instadarts-<version>.zip containing:
#
#   instadarts.mjs                  the whole server, dependencies inlined
#   client/                         the built frontend
#   instadarts.config.example.json  every setting, commented out
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
cp -r dist/client "$STAGE/client"

# ── 2. The server, as one file ───────────────────────────────────────
#    esbuild strips the TypeScript and inlines express and ws, so the
#    archive needs no dependencies of its own.
#
#    The banner is the file's first act: say where the client is and that
#    this is a production run, before any of the server's own top-level
#    code reads them. Everything is one module after bundling, so "first
#    in the file" is genuinely first.
#
#    INSTADARTS_CONFIG is defaulted rather than set, so it only applies
#    when the environment is silent — and it points beside this file, so
#    the settings can sit next to the thing they configure whichever
#    directory it is started from. A path that is not there falls through
#    to the working directory, which is what makes it a default and not a
#    demand.

NODE_MAJOR="$(node --version | cut -d. -f1 | tr -d v)"

banner="import { fileURLToPath as __toPath } from 'node:url';"
banner+="import { dirname as __dir, join as __join } from 'node:path';"
banner+="import { createRequire as __createRequire } from 'node:module';"
# express reaches `debug`, which does `require('tty')` at load time. Bundled to ESM there is no
# `require` for it to reach, and esbuild's shim throws rather than guessing — so give it one.
# esbuild's shim uses a `require` it can see, and this declares it above the shim's own line.
banner+="const require = __createRequire(import.meta.url);"
banner+="const __here = __dir(__toPath(import.meta.url));"
banner+="process.env.NODE_ENV = 'production';"
banner+="process.env.CLIENT_DIR = __join(__here, 'client');"
banner+="process.env.INSTADARTS_CONFIG = process.env.INSTADARTS_CONFIG ?? __join(__here, 'instadarts.config.json');"

echo "=== Bundling server ==="
npx esbuild src/server/index.ts \
  --bundle \
  --platform=node \
  --target="node${NODE_MAJOR}" \
  --format=esm \
  --banner:js="$banner" \
  --outfile="$STAGE/instadarts.mjs"

# ── 3. What the reader reads ─────────────────────────────────────────

cp instadarts.config.example.json "$STAGE/"
if [ -f README.md ]; then
  cp README.md "$STAGE/"
else
  echo "!!! no README.md — the archive will ship without one"
fi

# ── 4. The archive ───────────────────────────────────────────────────

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
