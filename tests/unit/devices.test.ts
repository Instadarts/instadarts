import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { resetDeviceRegistry } from '../../src/server/devices';
import { releaseRateLimit } from '../../src/server/rateLimit';
import type { ServerMessage } from '../../src/shared/protocol';

// ============================================================
// Harness
// ============================================================

let sessionCounter = 0;
const openSockets: WebSocket[] = [];

/**
 * A connection, driven exactly as the server drives a real one. The rate-limit bucket is cleared
 * before every message: these tests are about pairing, and 10 messages per second is not the
 * property under test.
 */
function connect() {
  const sessionId = `s${++sessionCounter}`;
  const received: ServerMessage[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;

  registerClient(ws, {
    sessionId,
    lobbyId: null,
    matchId: null,
    playerId: null,
    isSpectator: false,
    deviceId: null,
  });
  openSockets.push(ws);

  return {
    ws,
    sessionId,
    received,
    send(msg: object) {
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(msg));
    },
    last<T extends ServerMessage['type']>(type: T) {
      const hits = received.filter((m) => m.type === type);
      return hits[hits.length - 1] as Extract<ServerMessage, { type: T }> | undefined;
    },
    count(type: ServerMessage['type']) {
      return received.filter((m) => m.type === type).length;
    },
    disconnect() {
      removeClient(ws);
    },
  };
}

type Conn = ReturnType<typeof connect>;

/** The whole happy path: a frontend shows a code, a device redeems it, the frontend grabs it. */
function pair(frontend: Conn, grabbedAt = 1) {
  frontend.send({ type: 'create_pairing_code' });
  const code = frontend.last('pairing_code')!.code;

  const scorer = connect();
  scorer.send({ type: 'scorer_pair', code });

  const issued = scorer.last('scorer_paired')!;
  const announced = frontend.last('device_paired')!;
  frontend.send({
    type: 'activate_devices',
    devices: [{ deviceId: announced.deviceId, tokenHash: announced.tokenHash, grabbedAt }],
  });

  return { scorer, code, deviceId: issued.deviceId, token: issued.token, tokenHash: announced.tokenHash };
}

beforeEach(() => {
  resetDeviceRegistry();
});

afterEach(() => {
  vi.useRealTimers();
  for (const ws of openSockets.splice(0)) removeClient(ws);
  resetDeviceRegistry();
});

// ============================================================
// Pairing
// ============================================================

describe('pairing', () => {
  it('issues a code, a device redeems it, and both sides learn what they must keep', () => {
    const frontend = connect();
    frontend.send({ type: 'create_pairing_code' });

    const code = frontend.last('pairing_code')!;
    expect(code.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(code.expiresAt).toBeGreaterThan(Date.now());

    const scorer = connect();
    scorer.send({ type: 'scorer_pair', code: code.code });

    // The device gets the token, the frontend only ever gets its hash.
    const issued = scorer.last('scorer_paired')!;
    const announced = frontend.last('device_paired')!;
    expect(issued.deviceId).toBe(announced.deviceId);
    expect(issued.token.length).toBeGreaterThanOrEqual(32);
    expect(announced.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(announced).not.toHaveProperty('token');
  });

  it('accepts a code typed in lower case with spaces around it', () => {
    const frontend = connect();
    frontend.send({ type: 'create_pairing_code' });
    const code = frontend.last('pairing_code')!.code;

    const scorer = connect();
    scorer.send({ type: 'scorer_pair', code: `  ${code.toLowerCase()} ` });
    expect(scorer.last('scorer_paired')).toBeDefined();
  });

  it('reports the device as online and camera-active once it is grabbed', () => {
    const frontend = connect();
    const { scorer, deviceId } = pair(frontend);

    expect(frontend.last('devices_state')!.devices).toEqual([
      { deviceId, name: '', online: true, cameraActive: false },
    ]);
    expect(scorer.last('scorer_state')!.status).toBe('active');

    scorer.send({ type: 'scorer_camera', active: true });
    expect(frontend.last('devices_state')!.devices[0].cameraActive).toBe(true);
  });

  it('a device names itself and the name reaches the browser holding it', () => {
    const frontend = connect();
    const { scorer } = pair(frontend);

    scorer.send({ type: 'scorer_name', name: 'Board camera' });
    expect(frontend.last('devices_state')!.devices[0].name).toBe('Board camera');

    scorer.send({ type: 'scorer_name', name: '  Left mount  ' });
    expect(frontend.last('devices_state')!.devices[0].name).toBe('Left mount');
  });

  it('carries the name through a server restart, since the device brings it along', () => {
    const frontend = connect();
    const { deviceId, token, tokenHash, scorer } = pair(frontend);
    scorer.send({ type: 'scorer_name', name: 'Board camera' });

    resetDeviceRegistry();

    const reconnected = connect();
    reconnected.send({ type: 'scorer_hello', deviceId, token, name: 'Board camera' });
    const frontend2 = connect();
    frontend2.send({ type: 'activate_devices', devices: [{ deviceId, tokenHash, grabbedAt: 2 }] });

    expect(frontend2.last('devices_state')!.devices[0].name).toBe('Board camera');
  });

  it('leaves a device unnamed rather than accepting a name that is not one', () => {
    const frontend = connect();
    const { scorer } = pair(frontend);
    scorer.send({ type: 'scorer_name', name: 'Board camera' });

    // Clearing the field is a real intention, so an unusable name means "unnamed" rather than
    // being ignored — the browser then falls back to the label it gave the device at pairing.
    for (const name of ['', '   ', 'x'.repeat(21), null, 42, { name: 'x' }]) {
      scorer.send({ type: 'scorer_name', name });
      expect(frontend.last('devices_state')!.devices[0].name).toBe('');
    }
  });

  it('a device with no frontend holding it waits rather than scoring', () => {
    const frontend = connect();
    frontend.send({ type: 'create_pairing_code' });
    const scorer = connect();
    scorer.send({ type: 'scorer_pair', code: frontend.last('pairing_code')!.code });

    expect(scorer.last('scorer_state')!.status).toBe('waiting');
  });
});

// ============================================================
// Surviving a restart
// ============================================================

describe('re-authentication', () => {
  it('re-establishes the pairing after a server restart, device first', () => {
    const frontend = connect();
    const { deviceId, token, tokenHash } = pair(frontend);

    resetDeviceRegistry(); // the server restarted; it remembers nothing

    const scorer = connect();
    scorer.send({ type: 'scorer_hello', deviceId, token });
    const frontend2 = connect();
    frontend2.send({ type: 'activate_devices', devices: [{ deviceId, tokenHash, grabbedAt: 2 }] });

    expect(scorer.last('scorer_refused')).toBeUndefined();
    expect(frontend2.last('devices_state')!.devices).toEqual([
      { deviceId, name: '', online: true, cameraActive: false },
    ]);
    expect(scorer.last('scorer_state')!.status).toBe('active');
  });

  it('re-establishes the pairing after a restart, frontend first', () => {
    const frontend = connect();
    const { deviceId, token, tokenHash } = pair(frontend);

    resetDeviceRegistry();

    const frontend2 = connect();
    frontend2.send({ type: 'activate_devices', devices: [{ deviceId, tokenHash, grabbedAt: 2 }] });
    // Nothing has proven the device yet, so the claim is parked and does not count as online.
    expect(frontend2.last('devices_state')!.devices).toEqual([
      { deviceId, name: '', online: false, cameraActive: false },
    ]);

    const scorer = connect();
    scorer.send({ type: 'scorer_hello', deviceId, token });
    expect(frontend2.last('devices_state')!.devices[0].online).toBe(true);
  });
});

// ============================================================
// Bad actors
// ============================================================

describe('pairing — bad actors', () => {
  it('refuses a code that was never issued', () => {
    const scorer = connect();
    scorer.send({ type: 'scorer_pair', code: 'ZZZZZZ' });
    expect(scorer.last('scorer_refused')!.reason).toBe('bad_code');
    expect(scorer.last('scorer_paired')).toBeUndefined();
  });

  it('refuses malformed codes without crashing', () => {
    const scorer = connect();
    for (const code of ['', 'AB', 'ABCDEFGH', 'ABC-EF', 'aaaaaa!', null, 42, { code: 'x' }, ['A']]) {
      scorer.send({ type: 'scorer_pair', code });
    }
    expect(scorer.count('scorer_refused')).toBe(9);
    expect(scorer.count('scorer_paired')).toBe(0);
  });

  it('a code is single use — a second phone in the room cannot reuse it', () => {
    const frontend = connect();
    frontend.send({ type: 'create_pairing_code' });
    const code = frontend.last('pairing_code')!.code;

    const first = connect();
    first.send({ type: 'scorer_pair', code });
    expect(first.last('scorer_paired')).toBeDefined();

    const second = connect();
    second.send({ type: 'scorer_pair', code });
    expect(second.last('scorer_refused')!.reason).toBe('bad_code');
  });

  it('a code expires', () => {
    vi.useFakeTimers();
    const frontend = connect();
    frontend.send({ type: 'create_pairing_code' });
    const code = frontend.last('pairing_code')!.code;

    vi.setSystemTime(Date.now() + 121_000);

    const scorer = connect();
    scorer.send({ type: 'scorer_pair', code });
    expect(scorer.last('scorer_refused')!.reason).toBe('bad_code');
  });

  it('cuts off a connection guessing codes, even when it finally guesses right', () => {
    const frontend = connect();
    frontend.send({ type: 'create_pairing_code' });
    const code = frontend.last('pairing_code')!.code;

    const attacker = connect();
    for (let i = 0; i < 5; i++) attacker.send({ type: 'scorer_pair', code: 'ZZZZZZ' });
    attacker.send({ type: 'scorer_pair', code });

    expect(attacker.count('scorer_paired')).toBe(0);

    // And the real device is unaffected — the cap is per connection, not per code.
    const scorer = connect();
    scorer.send({ type: 'scorer_pair', code });
    expect(scorer.last('scorer_paired')).toBeDefined();
  });

  it('refuses a device id with the wrong token', () => {
    const frontend = connect();
    const { deviceId } = pair(frontend);

    const attacker = connect();
    attacker.send({ type: 'scorer_hello', deviceId, token: 'x'.repeat(43) });
    expect(attacker.last('scorer_refused')!.reason).toBe('unpaired');
  });

  it('refuses a hello with a malformed identity', () => {
    const attacker = connect();
    for (const [deviceId, token] of [
      ['', 'x'.repeat(43)],
      ['short', 'x'.repeat(43)],
      ['a'.repeat(22), ''],
      ['a'.repeat(22), 'tooshort'],
      [null, null],
      [{ deviceId: 1 }, ['t']],
    ]) {
      attacker.send({ type: 'scorer_hello', deviceId, token });
    }
    expect(attacker.count('scorer_refused')).toBe(6);
  });

  it('a frontend cannot take a live pairing by claiming it with a made-up hash', () => {
    const owner = connect();
    const { deviceId, scorer } = pair(owner);

    const attacker = connect();
    attacker.send({
      type: 'activate_devices',
      devices: [{ deviceId, tokenHash: 'f'.repeat(64), grabbedAt: Number.MAX_SAFE_INTEGER }],
    });

    expect(attacker.last('devices_state')!.devices).toEqual([]);
    expect(owner.last('device_lost')).toBeUndefined();
    expect(scorer.last('scorer_state')!.status).toBe('active');
  });

  it('a frontend that squatted a device id before a restart cannot lock the real one out', () => {
    const owner = connect();
    const { deviceId, token, tokenHash } = pair(owner);

    resetDeviceRegistry();

    // The attacker knows the id and gets there first, while nothing can yet disprove them.
    const attacker = connect();
    attacker.send({
      type: 'activate_devices',
      devices: [{ deviceId, tokenHash: 'f'.repeat(64), grabbedAt: Number.MAX_SAFE_INTEGER }],
    });

    // The device turns up and proves the real hash, which is what settles it.
    const scorer = connect();
    scorer.send({ type: 'scorer_hello', deviceId, token });
    expect(scorer.last('scorer_refused')).toBeUndefined();

    const owner2 = connect();
    owner2.send({ type: 'activate_devices', devices: [{ deviceId, tokenHash, grabbedAt: 1 }] });
    expect(owner2.last('devices_state')!.devices[0].online).toBe(true);
    expect(scorer.last('scorer_state')!.status).toBe('active');
  });

  it('ignores claims that are not shaped like claims', () => {
    const frontend = connect();
    frontend.send({ type: 'activate_devices', devices: 'nope' });
    frontend.send({ type: 'activate_devices', devices: [null, 7, { deviceId: 'x' }, { tokenHash: 'y' }] });
    frontend.send({ type: 'activate_devices', devices: [{ deviceId: 'a'.repeat(22), tokenHash: 'NOTHEX', grabbedAt: 1 }] });
    expect(frontend.last('devices_state')!.devices).toEqual([]);
  });
});

// ============================================================
// Two tabs, one browser
// ============================================================

describe('grabbing between tabs', () => {
  it('the newer grab wins and the loser is told to stop asking', () => {
    const tabA = connect();
    const { deviceId, tokenHash, scorer } = pair(tabA, 10);

    const tabB = connect();
    tabB.send({ type: 'activate_devices', devices: [{ deviceId, tokenHash, grabbedAt: 20 }] });

    expect(tabB.last('devices_state')!.devices[0].online).toBe(true);
    expect(tabA.last('device_lost')!.deviceId).toBe(deviceId);
    expect(tabA.last('devices_state')!.devices).toEqual([]);
    expect(scorer.last('scorer_state')!.status).toBe('active');
  });

  it('a stale background tab reconnecting cannot steal it back', () => {
    const tabA = connect();
    const { deviceId, tokenHash } = pair(tabA, 10);

    const tabB = connect();
    tabB.send({ type: 'activate_devices', devices: [{ deviceId, tokenHash, grabbedAt: 20 }] });

    // tabA's socket drops and reconnects, re-sending the grab it still has in sessionStorage.
    tabA.send({ type: 'activate_devices', devices: [{ deviceId, tokenHash, grabbedAt: 10 }] });

    expect(tabA.last('device_lost')!.deviceId).toBe(deviceId);
    expect(tabB.last('devices_state')!.devices[0].online).toBe(true);
    expect(tabA.last('devices_state')!.devices).toEqual([]);
  });

  it('re-grabbing from the same session is idempotent', () => {
    const frontend = connect();
    const { deviceId, tokenHash } = pair(frontend, 10);
    frontend.send({ type: 'activate_devices', devices: [{ deviceId, tokenHash, grabbedAt: 10 }] });

    expect(frontend.last('device_lost')).toBeUndefined();
    expect(frontend.last('devices_state')!.devices[0].online).toBe(true);
  });

  it('releases a device when the frontend gives it up', () => {
    const frontend = connect();
    const { deviceId, scorer } = pair(frontend);

    frontend.send({ type: 'deactivate_device', deviceId });
    expect(frontend.last('devices_state')!.devices).toEqual([]);
    expect(scorer.last('scorer_state')!.status).toBe('waiting');
  });

  it('releases a device when the frontend disconnects', () => {
    const frontend = connect();
    const { scorer } = pair(frontend);
    frontend.disconnect();
    expect(scorer.last('scorer_state')!.status).toBe('waiting');
  });

  it('marks the device offline when it disconnects', () => {
    const frontend = connect();
    const { scorer } = pair(frontend);
    scorer.disconnect();
    expect(frontend.last('devices_state')!.devices[0].online).toBe(false);
  });
});

// ============================================================
// The two vocabularies stay apart
// ============================================================

describe('scoring devices and frontends are different kinds of client', () => {
  it('a scoring device cannot reach a gameplay handler', () => {
    const frontend = connect();
    const { scorer } = pair(frontend);

    scorer.send({ type: 'create_lobby', isLocal: true });
    scorer.send({ type: 'add_dart', matchId: 'x', dart: { x: 1, y: 1 } });
    scorer.send({ type: 'spectate', id: 'x' });

    expect(scorer.count('lobby_state')).toBe(0);
    expect(scorer.count('match_state')).toBe(0);
  });

  it('a frontend cannot speak for a device it has not become', () => {
    const frontend = connect();
    pair(frontend);
    const before = frontend.count('devices_state');

    frontend.send({ type: 'scorer_camera', active: true });
    expect(frontend.count('devices_state')).toBe(before);
    expect(frontend.last('devices_state')!.devices[0].cameraActive).toBe(false);
  });

  it('a second socket for the same device displaces the first', () => {
    const frontend = connect();
    const { deviceId, token, scorer } = pair(frontend);

    const replacement = connect();
    replacement.send({ type: 'scorer_hello', deviceId, token });

    expect(scorer.last('scorer_refused')!.reason).toBe('unpaired');
    expect(replacement.last('scorer_state')!.status).toBe('active');
  });
});
