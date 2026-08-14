// The optional file a deployment tunes itself with, and what happens when it is not there.
//
// One file, read once at boot, holding every knob that is not a user setting — see shared/config.ts
// for the knobs themselves and their defaults. It is entirely optional: with no file the defaults
// are the deployment, which is what makes the executable something you can simply run.
//
// **Two extensions, and why.** The file carries comments, which JSON does not have — so a file named
// `.json` is one an editor is right to complain about, and `.jsonc` is the name for what it actually
// is. That is the one to prefer and the one shipped. `.json` is still accepted, because somebody who
// renames it will not think of it as a mistake and should not be told it was.
//
// **Where it is looked for**, first hit wins:
//
//   1. `INSTADARTS_CONFIG`, if set — a path to the file, not a directory. It locates the file rather
//      than setting anything in it, so a test run, or a second instance beside a first, can be
//      pointed at its own.
//   2. `INSTADARTS_DIR`, if set — a directory to look in. What the release bundle sets, so that the
//      settings can sit beside the thing they configure whichever directory it is started from.
//   3. The working directory.
//   4. Beside the running executable, which is where the file naturally sits when the program *is*
//      the executable rather than a script handed to `node`.
//
// Test processes skip the two implicit locations. They may still name a fixture with either
// environment variable, but a developer's deployment settings must not change a test run.
//
// **What a bad file does.** A file that is present but cannot be read or parsed stops the server: a
// deployment that thinks it is configured and is not is worth hearing about at boot rather than at
// the first dart. A single value that is the wrong type or out of range is a different thing — it is
// ignored, the default stands, and it says so on the way past, because one fat-fingered number
// should not take a server down. An unrecognised key is reported for the same reason: silently doing
// nothing is the one behaviour a configuration file must never have.

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { CONFIG_DEFAULTS, INTERNAL_ICE, type AppConfig } from '../shared/config';
import { QUIET } from './env';

/** Preferred first. Both are the same format; only the name differs. */
const FILE_NAMES = ['instadarts.config.jsonc', 'instadarts.config.json'];

function candidatePaths(): string[] {
  const paths: string[] = [];
  if (process.env.INSTADARTS_CONFIG) paths.push(resolve(process.env.INSTADARTS_CONFIG));
  const dirs = [
    ...(process.env.INSTADARTS_DIR ? [resolve(process.env.INSTADARTS_DIR)] : []),
    ...(process.env.NODE_ENV === 'test' ? [] : [process.cwd(), dirname(process.execPath)]),
  ];
  for (const dir of dirs) for (const name of FILE_NAMES) paths.push(join(resolve(dir), name));
  return [...new Set(paths)];
}

/**
 * JSON, less the comments.
 *
 * A configuration file that cannot explain itself is a configuration file nobody edits confidently,
 * and a knob you want to try without losing the old value is a knob you want to comment out. Strings
 * are respected, so a `//` inside an ICE url survives — which is the whole reason this is not a
 * regular expression.
 */
function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++; }
      // Newlines are kept so a parse error still reports the line the reader is looking at.
      else if (ch === '\n') out += ch;
      continue;
    }
    if (inString) {
      // A backslash escapes whatever follows, including a quote and including itself.
      if (ch === '\\') { out += ch + (next ?? ''); i++; continue; }
      if (ch === '"') inString = false;
      out += ch;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }
  return out;
}

/**
 * JSON, less a comma that separates nothing.
 *
 * The failure this exists for is **deleting a setting**, which is the one edit the shipped file
 * actively invites: it spells every knob out, and dropping one is how you go back to following the
 * default rather than pinning today's number forever. Delete the last line of a section and the line
 * above it is left with a comma and nothing to separate. Strict JSON refuses that — and refuses it
 * *pointing at the brace*, a line or more below the one that was actually touched.
 *
 * A knob commented out rather than deleted lands in the same place, from the other direction.
 *
 * Run after `stripComments`, so a comma separated from its bracket by nothing but a comment is seen
 * for what it is. Replaced with a space rather than removed, which keeps every later position — and
 * so every line number in a parse error — exactly where it was.
 */
function stripTrailingCommas(text: string): string {
  const out = [...text];
  let inString = false;
  /** The last comma seen with only whitespace since. -1 when the run has been broken. */
  let pending = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; pending = -1; continue; }
    if (ch === ',') { pending = i; continue; }
    if (ch === '}' || ch === ']') {
      if (pending >= 0) out[pending] = ' ';
      pending = -1;
      continue;
    }
    // Anything else with content ends the run. `,,` therefore survives to be rejected: a doubled
    // comma is a mistake with a value missing from it, not a comma with nothing left to separate.
    if (ch.trim() !== '') pending = -1;
  }
  return out.join('');
}

/** Everything the file got wrong, gathered rather than thrown one at a time. */
const complaints: string[] = [];

function complain(message: string): void {
  complaints.push(message);
}

type Raw = Record<string, unknown>;

function section(raw: Raw, key: string): Raw {
  const value = raw[key];
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    complain(`${key} should be an object; ignoring it`);
    return {};
  }
  return value as Raw;
}

/** A number that has to be whole and above zero — a port, a count, a size in pixels. */
function positiveInt(raw: Raw, path: string, key: string, fallback: number): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    complain(`${path}.${key} should be a whole number above zero; keeping ${fallback}`);
    return fallback;
  }
  return value;
}

/**
 * A whole number that may be zero, for the durations where zero says something.
 *
 * `resetMs: 0` means "hold the shot indefinitely" rather than "release it immediately", so zero is a
 * setting here and not the absence of one — which is exactly why it cannot go through `positiveInt`.
 */
function nonNegativeInt(raw: Raw, path: string, key: string, fallback: number): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    complain(`${path}.${key} should be a whole number, zero or above; keeping ${fallback}`);
    return fallback;
  }
  return value;
}

/** A number above zero that need not be whole. */
function positiveNumber(raw: Raw, path: string, key: string, fallback: number): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    complain(`${path}.${key} should be a number above zero; keeping ${fallback}`);
    return fallback;
  }
  return value;
}

/** A fraction of something: above zero, up to and including all of it. */
function fraction(raw: Raw, path: string, key: string, fallback: number): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    complain(`${path}.${key} should be a fraction above 0 and at most 1; keeping ${fallback}`);
    return fallback;
  }
  return value;
}

function bool(raw: Raw, path: string, key: string, fallback: boolean): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    complain(`${path}.${key} should be true or false; keeping ${fallback}`);
    return fallback;
  }
  return value;
}

/**
 * The `internal` sentinel, or a url with one of the schemes ICE understands. A typo becomes no
 * server rather than a client that throws.
 *
 * An empty list is a deployment saying host candidates only, and is left exactly as written — the
 * fallback is for a value that could not be read at all, and `[]` reads fine.
 */
function iceUrls(raw: Raw, path: string, key: string, fallback: string[]): string[] {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((url) => typeof url !== 'string')) {
    complain(`${path}.${key} should be a list of urls; keeping ${fallback.length ? fallback.join(', ') : 'none'}`);
    return fallback;
  }
  const urls = (value as string[]).map((url) => url.trim());
  const good = urls.filter((url) => url === INTERNAL_ICE || /^stuns?:|^turns?:/.test(url));
  for (const url of urls) {
    if (!good.includes(url)) {
      complain(`${path}.${key} entry "${url}" is not "${INTERNAL_ICE}" or a stun:/turn: url; ignoring it`);
    }
  }
  return good;
}

/**
 * The line the parser gave up on, quoted from the file the reader is actually looking at.
 *
 * `JSON.parse` reports a character offset and a line, but into the *stripped* text — and it names
 * where the grammar broke rather than where the mistake is, which for a missing comma is the line
 * after. Quoting the source line turns "position 392" into something a person can go and look at,
 * and it comes from the original text because that is the one with the comments still in it.
 *
 * Comments are blanked rather than deleted and a trailing comma becomes a space, so line numbers
 * survive both passes exactly. Returns nothing at all if the message has no position in it: a guess
 * pointing at the wrong line would be worse than no line.
 */
function quoteLine(err: unknown, stripped: string, original: string): string {
  const at = /at position (\d+)/.exec((err as Error).message);
  if (!at) return '';
  const line = stripped.slice(0, Number(at[1])).split('\n').length;
  const source = original.split('\n')[line - 1];
  return source === undefined ? '' : `\n  ${line} | ${source.trim()}`;
}

/** Anything in the file that no knob answers to. Almost always a typo, and always worth saying. */
function reportUnknown(raw: Raw, path: string, known: string[]): void {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) complain(`${path ? `${path}.` : ''}${key} is not a setting; ignoring it`);
  }
}

function readConfig(): { config: AppConfig; from: string | null } {
  const defaults = CONFIG_DEFAULTS;

  let text: string | null = null;
  let from: string | null = null;
  for (const path of candidatePaths()) {
    try {
      text = readFileSync(path, 'utf8');
      from = path;
      break;
    } catch (err) {
      // Not being there is the ordinary case and the whole point of the file being optional.
      // Anything else — a directory, a permission — is a file that was meant to be read and was not.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Could not read ${path}: ${(err as Error).message}`);
      }
    }
  }
  if (text === null || from === null) return { config: defaults, from: null };

  const bare = stripTrailingCommas(stripComments(text));
  let parsed: unknown;
  try {
    parsed = JSON.parse(bare);
  } catch (err) {
    throw new Error(`${from} is not valid JSON: ${(err as Error).message}${quoteLine(err, bare, text)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${from} should hold an object with the sections server, frontend, scorer and media`);
  }

  const raw = parsed as Raw;
  reportUnknown(raw, '', ['server', 'frontend', 'scorer', 'media']);

  const rawServer = section(raw, 'server');
  reportUnknown(rawServer, 'server', ['port', 'maxMatches']);

  const rawFrontend = section(raw, 'frontend');
  reportUnknown(rawFrontend, 'frontend', []);

  const rawScorer = section(raw, 'scorer');
  reportUnknown(rawScorer, 'scorer', ['cameraFrameRate']);

  const rawMedia = section(raw, 'media');
  reportUnknown(rawMedia, 'media', ['enabled', 'iceUrls', 'stunPort', 'still', 'video', 'virtualCamera', 'dartEvidence']);

  const rawStill = section(rawMedia, 'still');
  reportUnknown(rawStill, 'media.still', ['size']);

  const rawVideo = section(rawMedia, 'video');
  reportUnknown(rawVideo, 'media.video', ['size', 'frameRate', 'bitrate']);

  const rawCamera = section(rawMedia, 'virtualCamera');
  reportUnknown(rawCamera, 'media.virtualCamera', ['transitionMs', 'resetMs']);

  const rawEvidence = section(rawMedia, 'dartEvidence');
  reportUnknown(rawEvidence, 'media.dartEvidence', ['regionSize', 'transitionMs', 'resetMs']);

  return {
    from,
    config: {
      server: {
        port: positiveInt(rawServer, 'server', 'port', defaults.server.port),
        maxMatches: positiveInt(rawServer, 'server', 'maxMatches', defaults.server.maxMatches),
      },
      frontend: {},
      scorer: {
        cameraFrameRate: positiveNumber(rawScorer, 'scorer', 'cameraFrameRate', defaults.scorer.cameraFrameRate),
      },
      media: {
        enabled: bool(rawMedia, 'media', 'enabled', defaults.media.enabled),
        iceUrls: iceUrls(rawMedia, 'media', 'iceUrls', defaults.media.iceUrls),
        stunPort: positiveInt(rawMedia, 'media', 'stunPort', defaults.media.stunPort),
        still: {
          size: positiveInt(rawStill, 'media.still', 'size', defaults.media.still.size),
        },
        video: {
          size: positiveInt(rawVideo, 'media.video', 'size', defaults.media.video.size),
          frameRate: positiveNumber(rawVideo, 'media.video', 'frameRate', defaults.media.video.frameRate),
          bitrate: positiveInt(rawVideo, 'media.video', 'bitrate', defaults.media.video.bitrate),
        },
        virtualCamera: {
          transitionMs: nonNegativeInt(rawCamera, 'media.virtualCamera', 'transitionMs', defaults.media.virtualCamera.transitionMs),
          resetMs: nonNegativeInt(rawCamera, 'media.virtualCamera', 'resetMs', defaults.media.virtualCamera.resetMs),
        },
        dartEvidence: {
          regionSize: fraction(rawEvidence, 'media.dartEvidence', 'regionSize', defaults.media.dartEvidence.regionSize),
          transitionMs: nonNegativeInt(rawEvidence, 'media.dartEvidence', 'transitionMs', defaults.media.dartEvidence.transitionMs),
          resetMs: nonNegativeInt(rawEvidence, 'media.dartEvidence', 'resetMs', defaults.media.dartEvidence.resetMs),
        },
      },
    },
  };
}

/**
 * Held rather than thrown.
 *
 * A file that cannot be read or parsed still has to stop the server, but a throw from a module's top
 * level is a stack trace, and a stack trace is the wrong answer to a mistyped brace: it buries the
 * one line that says which file and where. So the reason is kept here and `index.ts` says it plainly
 * and exits.
 */
let fatal: string | null = null;

let config = CONFIG_DEFAULTS;
let from: string | null = null;
try {
  ({ config, from } = readConfig());
} catch (err) {
  fatal = (err as Error).message;
}

/** Where the settings came from, or null if nothing was found and the defaults are the deployment. */
export const CONFIG_PATH = from;

/** Everything a deployment may turn, with whatever the file did not say filled in from the defaults. */
export const CONFIG = config;

/** What the file got wrong, for whoever is starting the server to hear about. */
export const CONFIG_COMPLAINTS = complaints;

/** Why the settings could not be used at all, or null if they could. Fatal — see above. */
export const CONFIG_FATAL = fatal;

/** Said once at boot, and only when there is something to say or somebody to say it to. */
export function reportConfig(): void {
  if (QUIET) return;
  console.log(from ? `Settings: ${from}` : 'Settings: defaults (no instadarts.config.jsonc)');
  for (const complaint of complaints) console.warn(`  ${complaint}`);
}
