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
  const path = join(dir, `settings-${n++}.json`);
  writeFileSync(path, contents);
  vi.resetModules();
  vi.stubEnv('INSTADARTS_CONFIG', path);
  return await import('../../src/server/config');
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
    const { CONFIG, CONFIG_PATH, CONFIG_COMPLAINTS } = await import('../../src/server/config');

    expect(CONFIG).toEqual(CONFIG_DEFAULTS);
    expect(CONFIG_PATH).toBe(null);
    expect(CONFIG_COMPLAINTS).toEqual([]);
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
    await expect(load('{ "server": { "port": 3000 } ')).rejects.toThrow(/not valid JSON/);
  });

  it('refuses to start on a file that is not an object', async () => {
    await expect(load('[1, 2, 3]')).rejects.toThrow(/should hold an object/);
  });
});
