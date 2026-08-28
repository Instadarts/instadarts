#!/usr/bin/env bash
# Build the optional standalone .mjs archive: everything somebody needs to run InstaDarts, and
# nothing else. GitHub Releases contain source snapshots instead.
#
#   bash ./scripts/build-mjs.sh [version]
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

# ── 1. Our own licence, before anything expensive ────────────────────
#    The AGPL asks that a copy travel with every conveyed copy of the
#    program, so this is a condition of distributing the archive at all
#    rather than a courtesy. Checked first: an archive we may not hand
#    out is not worth the two minutes of bundling that would follow.

if [ ! -f LICENSE ]; then
  echo "!!! no LICENSE — refusing to build an archive we may not distribute" >&2
  exit 1
fi
cp LICENSE "$STAGE/"

# ── 2. The client ────────────────────────────────────────────────────

echo "=== Building client and checking types ==="
npm run build

# ── 3. What the licences ask for, on behalf of everybody else ────────
#    The archive carries other people's code — ws inside the .mjs,
#    React and LiteRT inside the client it embeds — and every licence
#    involved asks for its notice to travel with it.
#
#    Generated **before** the client is embedded, because the embedding
#    below sweeps up whatever dist/client holds and the app's own
#    "Third-party notices" link then serves it. `npm run build` left a
#    client-only list there; overwrite it with the full one, so the
#    notice inside the program and the notice beside it are the same
#    file rather than two answers to one question.
#
#    The metafile that makes the server half exact comes from a throwaway
#    esbuild pass, run while embeddedAssetsBundle.ts is still the null
#    stub — small and quick, and never executed. Which packages the
#    server pulls in does not depend on the client blob, so the list it
#    yields is the list the real bundle below will have.
#
#    `--external:vite` on both passes, and it is the notices that need it
#    rather than the size. devClient.ts reaches for Vite behind a flag no
#    production run sets, so the program never loads it — but a bundler
#    follows a dynamic import that a running program never will, and
#    would both inline the whole dev toolchain and list its licences as
#    though this archive redistributed them.

cleanup() {
  cat << 'EOF' > src/server/embeddedAssetsBundle.ts
/**
 * In standard repository runs, this is `null` (the server falls back to `CLIENT_DIR` if set, or to
 * the Vite dev client when `DEV_CLIENT` asks for one, or serves no client at all).
 *
 * When bundled by `scripts/build-mjs.sh`, this file is temporarily replaced with the
 * Base64-encoded, gzipped JSON dictionary containing every file in `dist/client`.
 */
export const EMBEDDED_CLIENT_BUNDLE: string | null = null;
EOF
  # Leave dist/ as `npm run build` would: the full notice belongs to the .mjs, not to a source
  # installation, which redistributes nothing and should not claim to.
  if [ -d dist/client ]; then
    node scripts/third-party-notices.mjs --client-only dist/client/THIRD-PARTY-NOTICES.txt > /dev/null
  fi
}
trap cleanup EXIT

echo "=== Reading server dependencies ==="
npx esbuild src/server/index.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --external:vite \
  --metafile="$OUT/server-meta.json" \
  --outfile="$OUT/server-probe.mjs"

echo "=== Third-party notices ==="
node scripts/third-party-notices.mjs "$OUT/server-meta.json" dist/client/THIRD-PARTY-NOTICES.txt
cp dist/client/THIRD-PARTY-NOTICES.txt "$STAGE/"

echo "=== Packaging embedded client ==="
node scripts/bundle-client.mjs dist/client src/server/embeddedAssetsBundle.ts

# ── 4. The server, as one file ───────────────────────────────────────
#    esbuild strips the TypeScript and inlines ws and the embedded
#    client assets, so the archive needs no dependencies or external
#    static files of its own.
#
#    --target=node22 is the floor the banner enforces, not whatever
#    Node happens to be building: a newer local Node must not emit
#    syntax the archive then claims to accept.
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

banner="const [__nodeMajor] = (process.versions.node || '').split('.').map(Number);"
banner+="if (!__nodeMajor || __nodeMajor < 22) { console.error('InstaDarts requires Node.js 22 or later (currently running on Node.js ' + (process.version || 'unknown') + ').'); process.exit(1); }"
banner+="import { fileURLToPath as __toPath } from 'node:url';"
banner+="import { dirname as __dir } from 'node:path';"
banner+="import { createRequire as __createRequire } from 'node:module';"
# ws reaches for `bufferutil` and `utf-8-validate` with a bare `require`, taking the absence of
# either as "use the JavaScript path". Bundled to ESM there is no `require` for it to reach, and
# esbuild's shim throws rather than reporting absence — which would turn an optional speedup into a
# startup crash. esbuild's shim uses a `require` it can see, and this declares it above that line.
banner+="const require = __createRequire(import.meta.url);"
banner+="const __here = __dir(__toPath(import.meta.url));"
banner+="process.env.NODE_ENV = 'production';"
banner+="process.env.INSTADARTS_DIR = process.env.INSTADARTS_DIR ?? __here;"

echo "=== Bundling server ==="
npx esbuild src/server/index.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --external:vite \
  --banner:js="$banner" \
  --outfile="$STAGE/instadarts.mjs"

# ── 5. What the reader reads ─────────────────────────────────────────

cp instadarts.config.example.jsonc "$STAGE/"
if [ -f README.md ]; then
  cp README.md "$STAGE/"
else
  echo "!!! no README.md — the archive will ship without one"
fi

# ── 6. The archive ───────────────────────────────────────────────────

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
