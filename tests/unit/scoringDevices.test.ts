// The frontend's view of its scoring devices: here, how a power-off survives the messages that
// report it. No browser, socket or server — the hook is fed `devices_state` messages directly.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../../src/shared/protocol';

// A hook runner that defers state updaters the way React does: a setter called outside a render
// only queues its update, and the queue is processed by the next render, in order. Running them
// immediately would hide exactly the bug this file is about, where an updater read a ref that a
// later message in the same batch had already moved.
const hooks = vi.hoisted(() => ({
  slots: [] as any[],
  cursor: 0,
  effects: [] as (() => void)[],
  queued: [] as (() => void)[],
}));
vi.mock('react', () => {
  const changed = (a: unknown[] | undefined, b: unknown[]) => !a || a.length !== b.length || b.some((v, i) => v !== a[i]);
  return {
    useRef(value: unknown) {
      const index = hooks.cursor++;
      return hooks.slots[index] ??= { current: value };
    },
    useState(initial: unknown) {
      const index = hooks.cursor++;
      hooks.slots[index] ??= { value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
      const slot = hooks.slots[index];
      return [slot.value, (next: any) => {
        hooks.queued.push(() => { slot.value = typeof next === 'function' ? next(slot.value) : next; });
      }];
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const index = hooks.cursor++;
      if (changed(hooks.slots[index]?.deps, deps)) hooks.slots[index] = { value: fn, deps };
      return hooks.slots[index].value;
    },
    useEffect(fn: () => void | (() => void), deps: unknown[]) {
      const index = hooks.cursor++;
      if (!changed(hooks.slots[index]?.deps, deps)) return;
      hooks.effects.push(() => {
        hooks.slots[index]?.cleanup?.();
        hooks.slots[index] = { deps, cleanup: fn() };
      });
    },
  };
});

// One device, paired to this browser and grabbed by this tab. Storage is the browser's, and this
// suite runs in node.
vi.mock('../../src/client/lib/deviceStorage', () => {
  const paired = [{ deviceId: 'phone', tokenHash: 'hash', name: 'Phone', pairedAt: 1 }];
  const grabs = [{ deviceId: 'phone', grabbedAt: 1 }];
  return {
    loadPairedDevices: () => paired,
    loadActiveGrabs: () => grabs,
    savePairedDevice: () => paired,
    renamePairedDevice: () => paired,
    forgetPairedDevice: () => [],
    setActiveGrab: () => grabs,
    clearActiveGrab: () => [],
  };
});

import { useScoringDevices } from '../../src/client/hooks/useScoringDevices';

/** One render: process what was queued, run the hook, then its effects. */
function render<T>(hook: () => T): T {
  for (const update of hooks.queued.splice(0)) update();
  hooks.cursor = 0;
  const result = hook();
  for (const effect of hooks.effects.splice(0)) effect();
  return result;
}

function devicesState(online: boolean, cameraActive: boolean): ServerMessage {
  return {
    type: 'devices_state',
    devices: [{ deviceId: 'phone', name: 'Phone', label: 'Phone', online, cameraActive, media: 'video' }],
  };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.queued = [];
});

describe('a device sent to standby', () => {
  function setup() {
    const send = vi.fn();
    const run = () => render(() => useScoringDevices(send, true));
    run();
    run().handleMessage(devicesState(true, true));
    return { run };
  }

  it('reads "powered off" even when its last two reports arrive in one batch', () => {
    const { run } = setup();
    run().powerOff('phone');
    const { handleMessage } = run();
    // What a power-off produces, back to back: the camera stopping, then the socket closing. Both
    // are handled before the next render processes either update.
    handleMessage(devicesState(true, false));
    handleMessage(devicesState(false, false));
    expect(run().devices[0]).toMatchObject({ online: false, poweredOff: true });
  });

  it('forgets it once the device is back, so the next disappearance is just offline', () => {
    const { run } = setup();
    run().powerOff('phone');
    run().handleMessage(devicesState(false, false));
    expect(run().devices[0].poweredOff).toBe(true);

    run().handleMessage(devicesState(true, false));
    run().handleMessage(devicesState(false, false));
    expect(run().devices[0]).toMatchObject({ online: false, poweredOff: false });
  });
});
