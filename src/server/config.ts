// The optional file a deployment tunes itself with, and what happens when it is not there.
//
// One file, read once at boot, holding every knob that is not a user setting — see shared/config.ts
// for the knobs themselves and their defaults. It is entirely optional: with no file the defaults
// are the deployment, which is what makes the executable something you can simply run.
//
// **Where it is looked for**, first hit wins:
//
//   1. `INSTADARTS_CONFIG`, if set — a path to the file, not a directory. The one environment
//      variable in this story, and it locates the file rather than setting anything in it. It exists
//      so a test run, or a second instance beside a first, can be pointed at its own file.
//   2. `instadarts.config.json` in the working directory.
//   3. `instadarts.config.json` beside the running executable, which is where it naturally sits when
//      the program *is* the executable rather than a script handed to `node`.
//
// **What a bad file does.** A file that is present but cannot be read or parsed stops the server: a
// deployment that thinks it is configured and is not is worth hearing about at boot rather than at
// the first dart. A single value that is the wrong type or out of range is a different thing — it is
// ignored, the default stands, and it says so on the way past, because one fat-fingered number
// should not take a server down. An unrecognised key is reported for the same reason: silently doing
// nothing is the one behaviour a configuration file must never have.

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { CONFIG_DEFAULTS, type AppConfig } from '../shared/config';
import { QUIET } from './env';

const FILE_NAME = 'instadarts.config.json';

function candidatePaths(): string[] {
  const paths: string[] = [];
  if (process.env.INSTADARTS_CONFIG) paths.push(resolve(process.env.INSTADARTS_CONFIG));
  paths.push(resolve(process.cwd(), FILE_NAME));
  paths.push(join(dirname(process.execPath), FILE_NAME));
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

/** Only the two schemes a STUN or TURN url can have. A typo becomes no server rather than a client that throws. */
function iceUrls(raw: Raw, path: string, key: string, fallback: string[]): string[] {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((url) => typeof url !== 'string')) {
    complain(`${path}.${key} should be a list of urls; keeping ${fallback.length ? fallback.join(', ') : 'none'}`);
    return fallback;
  }
  const urls = (value as string[]).map((url) => url.trim());
  const good = urls.filter((url) => /^stuns?:|^turns?:/.test(url));
  for (const url of urls) {
    if (!good.includes(url)) complain(`${path}.${key} entry "${url}" is not a stun: or turn: url; ignoring it`);
  }
  return good;
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripComments(text));
  } catch (err) {
    throw new Error(`${from} is not valid JSON: ${(err as Error).message}`);
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
  reportUnknown(rawMedia, 'media', ['enabled', 'iceUrls', 'still', 'video', 'dartEvidence']);

  const rawStill = section(rawMedia, 'still');
  reportUnknown(rawStill, 'media.still', ['size']);

  const rawVideo = section(rawMedia, 'video');
  reportUnknown(rawVideo, 'media.video', ['size', 'frameRate', 'bitrate']);

  const rawEvidence = section(rawMedia, 'dartEvidence');
  reportUnknown(rawEvidence, 'media.dartEvidence', ['regionSize', 'transitionMs']);

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
        still: {
          size: positiveInt(rawStill, 'media.still', 'size', defaults.media.still.size),
        },
        video: {
          size: positiveInt(rawVideo, 'media.video', 'size', defaults.media.video.size),
          frameRate: positiveNumber(rawVideo, 'media.video', 'frameRate', defaults.media.video.frameRate),
          bitrate: positiveInt(rawVideo, 'media.video', 'bitrate', defaults.media.video.bitrate),
        },
        dartEvidence: {
          regionSize: fraction(rawEvidence, 'media.dartEvidence', 'regionSize', defaults.media.dartEvidence.regionSize),
          transitionMs: positiveInt(rawEvidence, 'media.dartEvidence', 'transitionMs', defaults.media.dartEvidence.transitionMs),
        },
      },
    },
  };
}

const { config, from } = readConfig();

/** Where the settings came from, or null if nothing was found and the defaults are the deployment. */
export const CONFIG_PATH = from;

/** Everything a deployment may turn, with whatever the file did not say filled in from the defaults. */
export const CONFIG = config;

/** What the file got wrong, for whoever is starting the server to hear about. */
export const CONFIG_COMPLAINTS = complaints;

/** Said once at boot, and only when there is something to say or somebody to say it to. */
export function reportConfig(): void {
  if (QUIET) return;
  console.log(from ? `Settings: ${from}` : 'Settings: defaults (no instadarts.config.json)');
  for (const complaint of complaints) console.warn(`  ${complaint}`);
}
