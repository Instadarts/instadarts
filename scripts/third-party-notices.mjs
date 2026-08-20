// Build THIRD-PARTY-NOTICES.txt for the release archive.
//
//   node scripts/third-party-notices.mjs <server-metafile.json> <out.txt>
//
// The archive redistributes other people's code: express and ws are inlined into instadarts.mjs,
// React and LiteRT into client/assets, and LiteRT's WASM is copied in whole. Every licence involved
// permits that and every one of them asks for something back — MIT and ISC want their notice carried
// with the copy, Apache-2.0 additionally wants a copy of the licence itself and any NOTICE file,
// BSD wants its conditions reproduced. This is the file that does that, and it is generated rather
// than maintained so it cannot quietly fall behind the dependency it is attributing.
//
// **Two ways of finding what is in there**, because the two bundlers answer differently:
//
//   · The server is exact. esbuild writes a metafile naming every input it read, so the list is
//     what actually went in rather than what might have.
//   · The client is a closure over declared dependencies, seeded from what src/client imports.
//     Rollup's tree-shaking may drop some of it, which makes this a superset — and attributing a
//     package whose code did not survive is harmless, where missing one is not.
//
// A package that ships no licence text still has to be honoured: the SPDX id it declares is used to
// find a canonical copy in scripts/licenses/. If neither exists the build stops, because shipping an
// unattributed dependency is not something to discover after publishing.

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [metafilePath, outPath] = process.argv.slice(2);
if (!metafilePath || !outPath) {
  console.error('usage: node scripts/third-party-notices.mjs <server-metafile.json> <out.txt>');
  process.exit(1);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pkgDir = (name) => join(ROOT, 'node_modules', name);
const manifest = (name) => readJson(join(pkgDir(name), 'package.json'));

/** Everything esbuild actually read, reduced to package names. */
function serverPackages() {
  const inputs = Object.keys(readJson(metafilePath).inputs);
  const names = new Set();
  for (const path of inputs) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path);
    if (m) names.add(m[1]);
  }
  return names;
}

/** What src/client imports by name, so a new dependency is picked up without editing this file. */
function clientSeeds() {
  const seeds = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      for (const [, spec] of readFileSync(path, 'utf8').matchAll(/from ['"]([^'"]+)['"]/g)) {
        if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('@shared')) continue;
        seeds.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      }
    }
  };
  walk(join(ROOT, 'src', 'client'));
  return seeds;
}

/** A package plus everything its own dependencies pull in. */
function closure(seeds) {
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name) || !existsSync(pkgDir(name))) continue;
    seen.add(name);
    queue.push(...Object.keys(manifest(name).dependencies ?? {}));
  }
  return seen;
}

/** The licence as the package itself states it, or the canonical text for what it declares. */
function licenceText(name, spdx) {
  const dir = pkgDir(name);
  const files = readdirSync(dir).filter((f) => /^(LICEN[CS]E|COPYING)/i.test(f));
  if (files.length) return readFileSync(join(dir, files[0]), 'utf8').trimEnd();

  const canonical = join(ROOT, 'scripts', 'licenses', `${spdx}.txt`);
  if (existsSync(canonical)) return readFileSync(canonical, 'utf8').trimEnd();

  throw new Error(
    `${name} declares ${spdx} but ships no licence text, and scripts/licenses/${spdx}.txt does not ` +
    `exist. Add the canonical text there rather than shipping this unattributed.`,
  );
}

/** Apache-2.0 §4(c): a NOTICE file travels with the thing it belongs to. */
function noticeText(name) {
  const dir = pkgDir(name);
  const file = readdirSync(dir).find((f) => /^NOTICE/i.test(f));
  return file ? readFileSync(join(dir, file), 'utf8').trimEnd() : null;
}

const server = serverPackages();
const client = closure(clientSeeds());
const all = [...new Set([...server, ...client])].sort();

const rule = '='.repeat(96);
const out = [
  'THIRD-PARTY NOTICES',
  '',
  'InstaDarts is distributed with the open-source software listed below. Each entry is reproduced',
  'with the licence its authors chose; nothing here is InstaDarts\' own work and nothing here is',
  'modified. The full text of every licence follows its entry.',
  '',
  `Generated from the build itself — ${all.length} packages.`,
  '',
];

for (const name of all) {
  const m = manifest(name);
  const spdx = typeof m.license === 'string' ? m.license : (m.license?.type ?? 'UNKNOWN');
  const where = [server.has(name) && 'instadarts.mjs', client.has(name) && 'instadarts.mjs (client)'].filter(Boolean).join(', ');

  out.push(rule, `${name} ${m.version}`, `License: ${spdx}`);
  if (m.homepage) out.push(`Homepage: ${m.homepage}`);
  out.push(`Distributed in: ${where}`, '');

  const notice = noticeText(name);
  if (notice) out.push('NOTICE:', '', notice, '');
  out.push(licenceText(name, spdx), '');
}

writeFileSync(outPath, out.join('\n') + '\n');
console.log(`  ${all.length} packages (${server.size} server, ${client.size} client) -> ${outPath}`);
