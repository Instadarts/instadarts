import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../helpers';
import { makeMatch, makeDart } from '../helpers';
import { addDartToMatch, undoDartFromMatch, submitVisitToMatch } from '../../src/server/match';
import { useDartEvidence } from '../../src/client/hooks/useDartEvidence';
import { useStillResponder } from '../../src/client/hooks/useStillResponder';
import type { Mesh } from '../../src/client/media/mesh';
import type { ControlMessage, MediaPeer } from '../../src/shared/media';
import type { Capture } from '../../src/client/vision/stillCapture';

// A synchronous hook runner: state/refs and effect dependencies survive renders. No browser,
// camera or WebRTC stack is needed to deliver delayed control messages to the real hooks.
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', () => {
  const changed = (a: unknown[] | undefined, b: unknown[]) => !a || a.length !== b.length || b.some((v, i) => v !== a[i]);
  return {
    useRef(value: unknown) {
      const index = hooks.cursor++;
      return hooks.slots[index] ??= { current: value };
    },
    useState(value: unknown) {
      const index = hooks.cursor++;
      hooks.slots[index] ??= { value };
      return [hooks.slots[index].value, (next: any) => {
        hooks.slots[index].value = typeof next === 'function' ? next(hooks.slots[index].value) : next;
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
vi.mock('../../src/client/lib/e2e', () => ({ e2eEnabled: () => false }));

function render<T>(hook: () => T): T {
  hooks.cursor = 0;
  const result = hook();
  for (const effect of hooks.effects.splice(0)) effect();
  return result;
}

function meshFixture() {
  const camera: MediaPeer = { peerId: 'camera', kind: 'device', playerId: 'board', tier: 'stills',
    own: true, role: 'owner', polite: false, send: true, recv: false };
  const opponent: MediaPeer = { ...camera, peerId: 'opponent-camera', playerId: 'other-board', own: false, role: 'opponent' };
  const owner: MediaPeer = { ...camera, peerId: 'owner', kind: 'user', recv: true };
  const peers = [camera, opponent, owner];
  const sendControl = () => vi.fn((_message: ControlMessage, _payload?: Uint8Array) => true);
  const wires = new Map(peers.map((peer) => [peer.peerId, { sendControl: sendControl() }]));
  const mesh = {
    links: () => peers.map((peer) => ({ peer, ready: true, state: 'connected' })),
    link: (id: string) => wires.get(id),
    ownPeers: () => peers.filter((peer) => peer.own),
    isOwn: (id: string) => peers.some((peer) => peer.peerId === id && peer.own),
    viewers: () => [wires.get('owner')!],
  } as unknown as Mesh;
  return { mesh, peers, wires };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.effects = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${crypto.randomUUID()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  for (const slot of hooks.slots) slot?.cleanup?.();
  vi.restoreAllMocks();
});

describe('server evidence identities', () => {
  it('assigns IDs, preserves them on append/undo, and gives a replacement at identical coordinates a new ID', () => {
    const dart = { ...makeDart('S20'), id: 'client-supplied' };
    const first = addDartToMatch(makeMatch(), 'p1', dart);
    if (!first.success) throw new Error(first.error);
    expect(first.match.currentVisit?.id).toEqual(expect.any(String));
    expect(first.match.currentVisit?.darts[0].id).toEqual(expect.any(String));
    expect(first.match.currentVisit?.darts[0].id).not.toBe(dart.id);
    const second = addDartToMatch(first.match, 'p1', dart);
    if (!second.success) throw new Error(second.error);
    expect(second.match.currentVisit?.id).toBe(first.match.currentVisit?.id);
    expect(second.match.currentVisit?.darts[0].id).toBe(first.match.currentVisit?.darts[0].id);
    const undone = undoDartFromMatch(second.match);
    if (!undone.success) throw new Error(undone.error);
    const replacement = addDartToMatch(undone.match, 'p1', dart);
    if (!replacement.success) throw new Error(replacement.error);
    expect(replacement.match.currentVisit?.darts[1].id).not.toBe(second.match.currentVisit?.darts[1].id);
    const submitted = submitVisitToMatch(first.match);
    if (!submitted.success) throw new Error(submitted.error);
    const next = addDartToMatch(submitted.match, 'p2', dart);
    if (!next.success) throw new Error(next.error);
    expect(next.match.currentVisit?.id).not.toBe(first.match.currentVisit?.id);
    const empty = undoDartFromMatch(first.match);
    if (!empty.success) throw new Error(empty.error);
    const restarted = addDartToMatch(empty.match, 'p1', dart);
    if (!restarted.success) throw new Error(restarted.error);
    expect(restarted.match.currentVisit?.id).not.toBe(first.match.currentVisit?.id);
    expect(restarted.match.currentVisit?.darts[0].id).not.toBe(first.match.currentVisit?.darts[0].id);
  });
});

describe('dart evidence admission', () => {
  function setup(isThrower = false) {
    const fixture = meshFixture();
    const options = { mesh: fixture.mesh, links: fixture.mesh.links(), matchId: 'match', boardId: 'board',
      currentVisit: { id: 'visit', playerId: 'thrower', locked: false, darts: [{ ...makeDart('S20'), id: 'dart' }] },
      isThrower, enabled: true };
    const run = () => render(() => useDartEvidence(options));
    run();
    const request = fixture.wires.get('camera')!.sendControl.mock.calls[0]?.[0] as unknown as { id: string; tag: unknown } | undefined;
    const tag = { kind: 'dart_evidence', matchId: 'match', boardId: 'board', visitId: 'visit', dartId: 'dart', dart: 0 };
    const response: ControlMessage = { kind: 'still', id: request?.id ?? 'observer-copy', tag,
      width: 480, height: 480, mime: 'image/jpeg' };
    return { ...fixture, options, run, response, request };
  }
  const bytes = new Uint8Array([1, 2, 3]);

  it.each(['matchId', 'boardId', 'visitId', 'dartId'])('rejects a picture tagged for a different %s', (field) => {
    const f = setup();
    const response = { ...f.response, tag: { ...f.response.tag as object, [field]: 'stale' } };
    f.run().handleControl('camera', response, bytes);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('rejects an opponent camera even when it copies the current tag', () => {
    const f = setup();
    f.run().handleControl('opponent-camera', f.response, bytes);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('correlates the requesting owner response with the emitted request ID', () => {
    const f = setup(true);
    f.run().handleControl('camera', { ...f.response, id: 'unsolicited' }, bytes);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    f.run().handleControl('camera', f.response, bytes);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });
  it('puts the authoritative identities in the request tag', () => {
    const f = setup(true);
    expect(f.request?.tag).toEqual(f.response.tag);
  });
  it('allows the authorized camera fan-out for an observer that sent no request', () => {
    const f = setup();
    f.run().handleControl('camera', f.response, bytes);
    expect(f.run().images[0]).toMatch(/^blob:/);
  });
  it('does not replace accepted evidence with a duplicate reply', () => {
    const f = setup();
    f.run().handleControl('camera', f.response, bytes);
    f.run().handleControl('camera', f.response, bytes);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });
  it('retains earlier evidence on append and requests only the new dart', () => {
    const f = setup(true);
    f.run().handleControl('camera', f.response, bytes);
    const image = f.run().images[0];
    f.options.currentVisit = { ...f.options.currentVisit, darts: [
      ...f.options.currentVisit.darts, { ...makeDart('D20'), id: 'second-dart' },
    ] };
    f.run();
    expect(f.run().images[0]).toBe(image);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(f.wires.get('camera')!.sendControl).toHaveBeenCalledTimes(2);
  });
  it('rejects legacy index-only tags', () => {
    const f = setup();
    f.run().handleControl('camera', { ...f.response, tag: { dart: 0 } }, bytes);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('rejects a response after its camera link is replaced, even before a render', () => {
    const f = setup(true);
    const evidence = f.run();
    f.wires.set('camera', { sendControl: vi.fn((_message: ControlMessage, _payload?: Uint8Array) => true) });
    evidence.handleControl('camera', f.response, bytes);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    f.run();
    expect(f.wires.get('camera')!.sendControl).toHaveBeenCalledOnce();
  });
  it('clears old images and requests again when an undo/replacement has the same count and coordinates', () => {
    const f = setup(true);
    f.run().handleControl('camera', f.response, bytes);
    const previous = f.run().images[0];
    f.options.currentVisit = { ...f.options.currentVisit, darts: [{ ...f.options.currentVisit.darts[0], id: 'replacement' }] };
    f.run();
    expect(f.run().images.filter(Boolean)).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(previous);
    expect(f.wires.get('camera')!.sendControl).toHaveBeenCalledTimes(2);
    vi.mocked(URL.createObjectURL).mockClear();
    f.run().handleControl('camera', f.response, bytes);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('rejects evidence when disabled and reports no available camera for another board', () => {
    const f = setup();
    f.options.enabled = false;
    f.run().handleControl('camera', f.response, bytes);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    f.options.enabled = true;
    f.options.boardId = 'absent-board';
    expect(f.run().available).toBe(false);
  });
});

describe('asynchronous still capture', () => {
  it('answers and drains the queue when rendering refreshes wrappers around the same stream', async () => {
    const f = meshFixture();
    let resolve!: (value: Capture) => void;
    const pending = new Promise<Capture>((done) => { resolve = done; });
    const identity = {};
    const source = { capture: vi.fn(() => pending), located: () => true, identity: () => identity };
    const sourceRef = { current: source };
    const responder = render(() => useStillResponder({ current: f.mesh }, sourceRef));
    for (const id of ['one', 'two']) {
      responder.handleControl('owner', { kind: 'still_request', id, tag: { opaque: id }, to: ['owner'] });
    }
    sourceRef.current = { ...source, identity: () => identity };
    resolve({ blob: new Blob(['jpeg']), timing: { drawMs: 0, encodeMs: 0 } });
    const send = f.wires.get('owner')!.sendControl;
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(source.capture).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([message]) => message)).toEqual(['one', 'two'].map((id) =>
      expect.objectContaining({ kind: 'still', id, tag: { opaque: id } })));
    expect(send.mock.calls[0][1]).toEqual(new TextEncoder().encode('jpeg'));
  });

  it('rechecks ownership after reading the encoded bytes', async () => {
    const f = meshFixture();
    let resolve!: (value: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>((done) => { resolve = done; });
    const blob = new Blob(['jpeg']);
    const read = vi.spyOn(blob, 'arrayBuffer').mockReturnValue(pending);
    const identity = {};
    const source = { capture: async () => ({ blob, timing: { drawMs: 0, encodeMs: 0 } }),
      located: () => true, identity: () => identity };
    const responder = render(() => useStillResponder({ current: f.mesh }, { current: source }));
    responder.handleControl('owner', { kind: 'still_request', id: 'one', to: ['owner'] });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    f.peers.find((p) => p.peerId === 'owner')!.own = false;
    resolve(new ArrayBuffer(4));
    await new Promise((done) => setTimeout(done, 10));
    expect(f.wires.get('owner')!.sendControl).not.toHaveBeenCalled();
  });

  it.each(['mesh', 'source', 'owner', 'link'])('drops active and queued work when its %s changes', async (change) => {
    const f = meshFixture();
    let resolve!: (value: Capture) => void;
    const pending = new Promise<Capture>((done) => { resolve = done; });
    let sourceIdentity = {};
    const source = { capture: vi.fn(() => pending), located: () => true, identity: () => sourceIdentity };
    const sourceRef = { current: source };
    const meshRef = { current: f.mesh };
    const responder = render(() => useStillResponder(meshRef, sourceRef));
    responder.handleControl('owner', { kind: 'still_request', id: 'one', to: ['owner'] });
    responder.handleControl('owner', { kind: 'still_request', id: 'two', to: ['owner'] });
    const originalLink = f.wires.get('owner')!;
    if (change === 'mesh') meshRef.current = meshFixture().mesh;
    if (change === 'source') sourceIdentity = {};
    if (change === 'owner') f.peers.find((p) => p.peerId === 'owner')!.own = false;
    if (change === 'link') f.wires.set('owner', { sendControl: vi.fn((_message: ControlMessage, _payload?: Uint8Array) => true) });
    resolve({ blob: new Blob(['jpeg']), timing: { drawMs: 0, encodeMs: 0 } });
    await vi.waitFor(() => expect(source.capture).toHaveBeenCalledTimes(1));
    await new Promise((done) => setTimeout(done, 10));
    expect(originalLink.sendControl).not.toHaveBeenCalled();
    expect(f.wires.get('owner')!.sendControl).not.toHaveBeenCalled();
    expect(source.capture).toHaveBeenCalledTimes(1);
  });
});
