import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CONFIG_DEFAULTS } from '../../src/shared/config';

/**
 * The settings file.
 *
 * Every one of these is about the same property: **a deployment gets what it asked for, or the
 * default, and never a third thing.** A knob that silently reverts is a deployment that is not
 * running what its operator believes, which is worse than one that refuses to start — so the two
 * halves worth pinning are that a good value arrives intact, and that a bad one is both ignored
 * *and* complained about rather than quietly taken.
 */

const dir = mkdtempSync(join(tmpdir(), 'instadarts-config-'));
let n = 0;

/** Write a settings file, read it the way the server does, and hand back what it made of it. */
async function load(contents: string) {
  const path = join(dir, `settings-${n++}.jsonc`);
  writeFileSync(path, contents);
  vi.resetModules();
  vi.stubEnv('INSTADARTS_CONFIG', path);
  return await import('../../src/server/config');
}

/** Put named files in a directory of their own and let the server find one, as a deployment does. */
async function loadFromDir(files: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'instadarts-dir-'));
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(home, name), contents);
  vi.resetModules();
  vi.stubEnv('INSTADARTS_DIR', home);
  return { home, ...(await import('../../src/server/config')) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('with no file at all', () => {
  it('is the defaults, and says so', async () => {
    vi.resetModules();
    // A path that is not there, which is the ordinary case: an install nobody has configured.
    vi.stubEnv('INSTADARTS_CONFIG', join(dir, 'nothing-here.json'));
    const { CONFIG, CONFIG_PATH, CONFIG_COMPLAINTS, CONFIG_FATAL } = await import('../../src/server/config');

    expect(CONFIG).toEqual(CONFIG_DEFAULTS);
    expect(CONFIG_PATH).toBe(null);
    expect(CONFIG_COMPLAINTS).toEqual([]);
    expect(CONFIG_FATAL).toBe(null);
  });
});

describe('what the file says', () => {
  it('takes each knob, and fills the rest in from the defaults', async () => {
    const { CONFIG, CONFIG_PATH, CONFIG_COMPLAINTS } = await load(`{
      "server": { "maxMatches": 250 },
      "scorer": { "cameraFrameRate": 30 },
      "media": { "still": { "size": 480 } }
    }`);

    expect(CONFIG.server.maxMatches).toBe(250);
    expect(CONFIG.scorer.cameraFrameRate).toBe(30);
    expect(CONFIG.media.still.size).toBe(480);
    // Untouched sections and untouched neighbours are the defaults, not undefined.
    expect(CONFIG.server.port).toBe(CONFIG_DEFAULTS.server.port);
    expect(CONFIG.media.video).toEqual(CONFIG_DEFAULTS.media.video);
    expect(CONFIG.media.dartEvidence).toEqual(CONFIG_DEFAULTS.media.dartEvidence);

    expect(CONFIG_PATH).not.toBe(null);
    expect(CONFIG_COMPLAINTS).toEqual([]);
  });

  it('can turn media off, which is the setting that has to work', async () => {
    const { CONFIG } = await load('{ "media": { "enabled": false } }');
    expect(CONFIG.media.enabled).toBe(false);
  });

  it('keeps comments out of the way, including a // inside a url', async () => {
    const { CONFIG, CONFIG_COMPLAINTS } = await load(`{
      // The whole reason this is not plain JSON.
      "media": {
        /* A block comment, and a knob parked out of the way rather than deleted:
           "enabled": false, */
        "iceUrls": ["stun:stun.example.org:19302"]
      }
    }`);

    expect(CONFIG.media.iceUrls).toEqual(['stun:stun.example.org:19302']);
    expect(CONFIG.media.enabled).toBe(true);
    expect(CONFIG_COMPLAINTS).toEqual([]);
  });
});

/**
 * What a person editing the file by hand is likely to leave behind.
 *
 * The shipped file spells every setting out, and deleting one is how you go back to following the
 * default instead of pinning today's number. Delete the last in a section and the line above keeps a
 * comma with nothing left to separate. Strict JSON refuses that, and refuses it pointing at a line
 * the reader never touched. These are the tests that say it must not.
 */
describe('what a hand-edited file is forgiven', () => {
  it('takes a comma left dangling before a brace, which is what deleting the last setting leaves', async () => {
    const { CONFIG, CONFIG_FATAL, CONFIG_COMPLAINTS } = await load(`{
      "media": {
        "video": {
          "size": 480,
        }
      },
    }`);

    expect(CONFIG_FATAL).toBe(null);
    expect(CONFIG.media.video.size).toBe(480);
    // Forgiven, not tolerated-and-grumbled-about: it is not the operator's mistake to hear about.
    expect(CONFIG_COMPLAINTS).toEqual([]);
  });

  it('takes one before a bracket too, and one that only a comment separated from its brace', async () => {
    const { CONFIG, CONFIG_FATAL } = await load(`{
      "media": {
        "iceUrls": [
          "internal",
        ],
        "stunPort": 3478
        // and nothing after it
        ,
      }
    }`);

    expect(CONFIG_FATAL).toBe(null);
    expect(CONFIG.media.iceUrls).toEqual(['internal']);
  });

  it('still refuses a doubled comma, which is a value missing rather than a comma spare', async () => {
    const { CONFIG_FATAL } = await load('{ "media": { "iceUrls": ["internal",,"stun:a.example:1"] } }');
    expect(CONFIG_FATAL).toMatch(/not valid JSON/);
  });

  it('quotes the line it gave up on, since a position in a file nobody can see is not a message', async () => {
    // A missing comma: valid until the parser reaches the *next* key, so the position it reports is
    // a line below the mistake. Quoting the source is what makes that recoverable.
    const { CONFIG_FATAL } = await load(`{
      "server": {
        "port": 3000
        "maxMatches": 250
      }
    }`);

    expect(CONFIG_FATAL).toMatch(/not valid JSON/);
    expect(CONFIG_FATAL).toContain('"maxMatches": 250');
  });
});

/**
 * The shipped example, read the way a deployment would read its own copy.
 *
 * The file spells every setting out at the value it already has, which is only true for as long as
 * somebody keeps it true — and a settings file that quietly disagrees with the program is worse than
 * none, because it is the thing an operator will believe. So the claim is checked rather than
 * maintained by hand: change a default without changing the example and this is what says so.
 *
 * It doubles as the parser's widest test. Every knob, every nesting depth, every comment style and
 * an array all arrive here in one file, and the assertion is exact — not "no error" but "exactly the
 * defaults", which is the only result that means the file was both read and understood.
 */
describe('the example file', () => {
  it('is the defaults, spelled out', async () => {
    const example = join(import.meta.dirname, '..', '..', 'instadarts.config.example.jsonc');
    vi.resetModules();
    vi.stubEnv('INSTADARTS_CONFIG', example);
    const { CONFIG, CONFIG_COMPLAINTS, CONFIG_FATAL } = await import('../../src/server/config');

    expect(CONFIG_FATAL).toBe(null);
    // Not a subset and not merely valid: every value in the file is the value it would have had.
    expect(CONFIG).toEqual(CONFIG_DEFAULTS);
    // Which also means no key in it is one the server does not know — a typo would land here.
    expect(CONFIG_COMPLAINTS).toEqual([]);
  });
});

describe('which file it reads', () => {
  it('finds either extension in a directory it is pointed at', async () => {
    const jsonc = await loadFromDir({ 'instadarts.config.jsonc': '{ "server": { "maxMatches": 11 } }' });
    expect(jsonc.CONFIG.server.maxMatches).toBe(11);
    expect(jsonc.CONFIG_PATH).toBe(join(jsonc.home, 'instadarts.config.jsonc'));

    vi.unstubAllEnvs();
    const json = await loadFromDir({ 'instadarts.config.json': '{ "server": { "maxMatches": 22 } }' });
    expect(json.CONFIG.server.maxMatches).toBe(22);
  });

  it('does not read the example, which is shipped in the very directory it searches', async () => {
    // The release archive puts `instadarts.config.example.jsonc` beside the executable and points
    // INSTADARTS_DIR at that directory, so "the example is not a settings file" is a property of the
    // shipped layout rather than a nicety. It reads as one — same syntax, every knob present — and
    // now that it carries real values instead of commented-out ones, picking it up would look like
    // nothing at all going wrong while silently pinning every default it names.
    const { CONFIG, CONFIG_PATH } = await loadFromDir({
      'instadarts.config.example.jsonc': '{ "server": { "maxMatches": 777 } }',
    });

    expect(CONFIG_PATH).toBe(null);
    expect(CONFIG.server.maxMatches).toBe(CONFIG_DEFAULTS.server.maxMatches);
  });

  it('prefers .jsonc when both are there, because that is the one it ships', async () => {
    const { CONFIG, CONFIG_PATH, home } = await loadFromDir({
      'instadarts.config.jsonc': '{ "server": { "maxMatches": 11 } }',
      'instadarts.config.json': '{ "server": { "maxMatches": 22 } }',
    });

    expect(CONFIG.server.maxMatches).toBe(11);
    expect(CONFIG_PATH).toBe(join(home, 'instadarts.config.jsonc'));
  });
});

/**
 * The two durations where **zero is a value rather than the absence of one.**
 *
 * Everywhere else in this file a zero is a mistake worth complaining about — a size, a port, a frame
 * rate. Here it means "never release the shot", which is a thing a deployment is allowed to say and
 * which `positiveInt` would have silently overruled.
 */
describe('the virtual camera timings', () => {
  it('takes a zero, which means the camera never goes back on its own', async () => {
    const { CONFIG, CONFIG_COMPLAINTS } = await load(`{
      "media": {
        "virtualCamera": { "transitionMs": 0, "resetMs": 0 },
        "dartEvidence": { "resetMs": 0, "transitionMs": 0 }
      }
    }`);

    expect(CONFIG.media.virtualCamera).toEqual({ transitionMs: 0, resetMs: 0 });
    expect(CONFIG.media.dartEvidence.resetMs).toBe(0);
    // A cut, which is what a zero transition has always meant.
    expect(CONFIG.media.dartEvidence.transitionMs).toBe(0);
    expect(CONFIG_COMPLAINTS).toEqual([]);
  });

  it('keeps the default and complains at a negative one, which means nothing at all', async () => {
    const { CONFIG, CONFIG_COMPLAINTS } = await load(`{
      "media": {
        "virtualCamera": { "resetMs": -1 },
        "dartEvidence": { "resetMs": 2.5 }
      }
    }`);

    expect(CONFIG.media.virtualCamera.resetMs).toBe(CONFIG_DEFAULTS.media.virtualCamera.resetMs);
    expect(CONFIG.media.dartEvidence.resetMs).toBe(CONFIG_DEFAULTS.media.dartEvidence.resetMs);
    expect(CONFIG_COMPLAINTS.join('\n')).toContain('media.virtualCamera.resetMs');
    expect(CONFIG_COMPLAINTS.join('\n')).toContain('media.dartEvidence.resetMs');
  });

  it('keeps the two apart: the general fallback, and one caller overriding it', async () => {
    // The distinction the section exists for. A deployment that moves the fallback must not move
    // what dart evidence sends, and the other way about.
    const { CONFIG } = await load(`{
      "media": { "virtualCamera": { "transitionMs": 111, "resetMs": 222 } }
    }`);

    expect(CONFIG.media.virtualCamera).toEqual({ transitionMs: 111, resetMs: 222 });
    expect(CONFIG.media.dartEvidence.transitionMs).toBe(CONFIG_DEFAULTS.media.dartEvidence.transitionMs);
    expect(CONFIG.media.dartEvidence.resetMs).toBe(CONFIG_DEFAULTS.media.dartEvidence.resetMs);
  });
});

/**
 * The one setting whose *default* is the interesting half.
 *
 * `iceUrls` decides two things at once — which servers clients are told about, and whether this
 * deployment runs one of its own — and it does so on purpose: a deployment cannot end up running a
 * STUN server nobody is told about, or advertising one that is not running. Each test below is one
 * way that could come apart.
 */
describe('the internal stun server', () => {
  it('is what an unconfigured deployment gets', async () => {
    const { CONFIG } = await load('{}');
    expect(CONFIG.media.iceUrls).toEqual(['internal']);
    expect(CONFIG.media.stunPort).toBe(3478);
  });

  it('survives being written down, and is not mistaken for a bad url', async () => {
    const { CONFIG, CONFIG_COMPLAINTS } = await load('{ "media": { "iceUrls": ["internal"] } }');
    expect(CONFIG.media.iceUrls).toEqual(['internal']);
    expect(CONFIG_COMPLAINTS).toEqual([]);
  });

  it('is switched off by naming somebody else, and kept by naming both', async () => {
    const { CONFIG: theirs } = await load('{ "media": { "iceUrls": ["stun:stun.example.org:19302"] } }');
    expect(theirs.media.iceUrls).toEqual(['stun:stun.example.org:19302']);

    // Order is what makes this worth saying rather than a set: ours first means ours is tried first.
    const { CONFIG: both } = await load(`{
      "media": { "iceUrls": ["internal", "stun:stun.example.org:19302"] }
    }`);
    expect(both.media.iceUrls).toEqual(['internal', 'stun:stun.example.org:19302']);
  });

  it('is switched off by an empty list, which is host candidates only', async () => {
    // The distinction that has to hold: an empty list is a deployment saying something, and the
    // default is a deployment saying nothing. They must not collapse into each other.
    const { CONFIG, CONFIG_COMPLAINTS } = await load('{ "media": { "iceUrls": [] } }');
    expect(CONFIG.media.iceUrls).toEqual([]);
    expect(CONFIG_COMPLAINTS).toEqual([]);
  });

  it('takes a port, and keeps the default rather than a port that cannot be one', async () => {
    const { CONFIG: moved } = await load('{ "media": { "stunPort": 19302 } }');
    expect(moved.media.stunPort).toBe(19302);

    const { CONFIG, CONFIG_COMPLAINTS } = await load('{ "media": { "stunPort": 0 } }');
    expect(CONFIG.media.stunPort).toBe(CONFIG_DEFAULTS.media.stunPort);
    expect(CONFIG_COMPLAINTS.join('\n')).toContain('media.stunPort');
  });
});

describe('match media setup timeout', () => {
  it('defaults to four seconds and accepts an explicit non-negative duration', async () => {
    expect((await load('{}')).CONFIG.media.setupTimeoutMs).toBe(4000);
    expect((await load('{ "media": { "setupTimeoutMs": 0 } }')).CONFIG.media.setupTimeoutMs).toBe(0);
    expect((await load('{ "media": { "setupTimeoutMs": 7500 } }')).CONFIG.media.setupTimeoutMs).toBe(7500);
  });

  it('keeps the default for invalid values', async () => {
    const { CONFIG, CONFIG_COMPLAINTS } = await load('{ "media": { "setupTimeoutMs": -1 } }');
    expect(CONFIG.media.setupTimeoutMs).toBe(CONFIG_DEFAULTS.media.setupTimeoutMs);
    expect(CONFIG_COMPLAINTS.join('\n')).toContain('media.setupTimeoutMs');
  });
});

describe('what the file gets wrong', () => {
  it('keeps the default and complains, rather than taking a number that would disable a limit', async () => {
    // A zero, a fraction or a word in maxMatches would divide through every derived limit.
    const { CONFIG, CONFIG_COMPLAINTS } = await load(`{
      "server": { "maxMatches": 0 },
      "scorer": { "cameraFrameRate": "lots" },
      "media": { "dartEvidence": { "regionSize": 4 } }
    }`);

    expect(CONFIG.server.maxMatches).toBe(CONFIG_DEFAULTS.server.maxMatches);
    expect(CONFIG.scorer.cameraFrameRate).toBe(CONFIG_DEFAULTS.scorer.cameraFrameRate);
    // A region bigger than the board is not a region.
    expect(CONFIG.media.dartEvidence.regionSize).toBe(CONFIG_DEFAULTS.media.dartEvidence.regionSize);

    expect(CONFIG_COMPLAINTS).toHaveLength(3);
    expect(CONFIG_COMPLAINTS.join('\n')).toContain('server.maxMatches');
  });

  it('names a key it does not recognise, because doing nothing quietly is the one thing it must not do', async () => {
    const { CONFIG_COMPLAINTS } = await load('{ "server": { "maxMatchs": 250 }, "storage": {} }');

    expect(CONFIG_COMPLAINTS.join('\n')).toContain('server.maxMatchs');
    expect(CONFIG_COMPLAINTS.join('\n')).toContain('storage');
  });

  it('drops an ice url that is not one, and keeps the rest', async () => {
    const { CONFIG, CONFIG_COMPLAINTS } = await load(`{
      "media": { "iceUrls": ["stun:stun.example.org:19302", "http://example.org"] }
    }`);

    expect(CONFIG.media.iceUrls).toEqual(['stun:stun.example.org:19302']);
    expect(CONFIG_COMPLAINTS.join('\n')).toContain('http://example.org');
  });

  it('refuses to start on a file it cannot parse', async () => {
    // A single value being wrong is worth surviving; a file that is not JSON means the operator's
    // intent is entirely unknown, and starting anyway would run a deployment nobody asked for.
    // Reported rather than thrown, so what reaches the operator is the reason and not a stack.
    const { CONFIG_FATAL, CONFIG } = await load('{ "server": { "port": 3000 } ');
    expect(CONFIG_FATAL).toMatch(/not valid JSON/);
    // And nothing half-applied: what is left is the defaults, which nobody will get to run.
    expect(CONFIG).toEqual(CONFIG_DEFAULTS);
  });

  it('refuses to start on a file that is not an object', async () => {
    const { CONFIG_FATAL } = await load('[1, 2, 3]');
    expect(CONFIG_FATAL).toMatch(/should hold an object/);
  });
});
