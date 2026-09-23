import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../helpers';
import { makeMatch, makeDart } from '../helpers';
import { addDartToMatch, undoDartFromMatch, submitVisitToMatch } from '../../src/server/match';
import { useDartEvidence } from '../../src/client/hooks/useDartEvidence';
import { useStillResponder } from '../../src/client/hooks/useStillResponder';
import type { Mesh } from '../../src/client/media/mesh';
import type { ControlMessage, MediaPeer } from '../../src/shared/media';
import type { DartDetection, DartThrow } from '../../src/shared/types';
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
const e2e = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../src/client/lib/e2e', () => ({ e2eEnabled: () => e2e.enabled }));

function render<T>(hook: () => T): T {
  hooks.cursor = 0;
  const result = hook();
  for (const effect of hooks.effects.splice(0)) effect();
  return result;
}

/** A scorer of the thrower's own, as the owner's roster describes it. */
function ownScorer(peerId: string, scorer: string, fields: Partial<MediaPeer> = {}): MediaPeer {
  return { peerId, kind: 'device', playerId: 'board', tier: 'stills', own: true, role: 'owner',
    polite: false, send: true, recv: false, scorer, scorerId: `public-${peerId}`, live: false, cameraOn: true, ...fields };
}

function meshFixture(extra: MediaPeer[] = []) {
  const camera = ownScorer('camera', 'Phone', { live: true });
  const opponent: MediaPeer = { peerId: 'opponent-camera', kind: 'device', playerId: 'other-board', tier: 'stills',
    own: false, role: 'opponent', polite: false, send: true, recv: false };
  const owner: MediaPeer = { peerId: 'owner', kind: 'user', playerId: 'board', tier: 'stills',
    own: true, role: 'owner', polite: false, send: true, recv: true };
  const peers = [camera, opponent, owner, ...extra];
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

function setup(isThrower = false, { extra = [] as MediaPeer[], dart = {} as Partial<DartThrow> } = {}) {
  const fixture = meshFixture(extra);
  const options = { mesh: fixture.mesh, links: fixture.mesh.links(), matchId: 'match', boardId: 'board',
    currentVisit: { id: 'visit', playerId: 'thrower', locked: false, darts: [{ ...makeDart('S20'), id: 'dart', ...dart }] },
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

describe('dart evidence admission', () => {

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
  it.each([true, false])('keeps received evidence available after every source leaves (thrower=%s)', (isThrower) => {
    const f = setup(isThrower);
    f.run().handleControl('camera', f.response, bytes);
    const image = f.run().images[0];
    f.peers.splice(0);
    f.wires.clear();
    f.options.links = f.mesh.links();
    const evidence = f.run();
    expect(evidence.available).toBe(true);
    expect(evidence.images[0]).toBe(image);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    f.options.enabled = false;
    f.run();
    expect(f.run().available).toBe(false);
    expect(f.run().images).toEqual([]);
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
    // A replaced link is a mesh change, and the mesh reports every one of those as new links.
    f.options.links = f.mesh.links();
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

describe('which scorer is asked', () => {
  const placedBy = (winningScorer: string): Partial<DartThrow> => ({ detection: {
    expectedScorers: 2, reportingScorers: 2, contributingScorers: 1, winningScorer, winningScorerId: `public-${winningScorer.toLowerCase()}`, winningConfidence: 0.9,
  } satisfies DartDetection });
  const asked = (f: ReturnType<typeof setup>, peerId: string) => f.wires.get(peerId)!.sendControl.mock.calls.length;

  it('asks the scorer that placed the dart, not the live camera', () => {
    const f = setup(true, { extra: [ownScorer('left', 'Left')], dart: placedBy('Left') });
    expect(asked(f, 'left')).toBe(1);
    expect(asked(f, 'camera')).toBe(0);
  });

  it('retries the same winning scorer after its old label moves to another camera', () => {
    const f = setup(true, { extra: [ownScorer('left', 'Left')], dart: placedBy('Left') });
    f.peers.find((peer) => peer.peerId === 'left')!.scorer = 'Renamed';
    f.peers.find((peer) => peer.peerId === 'camera')!.scorer = 'Left';
    f.wires.set('left', { sendControl: vi.fn(() => true) });
    f.options.links = f.mesh.links();
    f.run();
    expect(asked(f, 'left')).toBe(1);
    expect(asked(f, 'camera')).toBe(0);
    expect(f.options.currentVisit.darts[0].detection?.winningScorer).toBe('Left');
  });

  it('falls back to the live camera when the scorer that placed the dart is not sharing', () => {
    const f = setup(true, { extra: [ownScorer('left', 'Left')], dart: placedBy('Gone') });
    expect(asked(f, 'camera')).toBe(1);
    expect(asked(f, 'left')).toBe(0);
  });

  it('asks the live camera first about a manually added dart', () => {
    const f = setup(true, { extra: [ownScorer('left', 'Left')] });
    expect(asked(f, 'camera')).toBe(1);
  });

  it('passes over a live camera whose camera is off, then takes the rest by label', () => {
    const f = setup(true, { extra: [ownScorer('zed', 'Zed'), ownScorer('left', 'Left')] });
    f.peers.find((peer) => peer.peerId === 'camera')!.cameraOn = false;
    f.options.links = f.mesh.links();
    f.options.currentVisit = { ...f.options.currentVisit, darts: [{ ...f.options.currentVisit.darts[0], id: 'next' }] };
    f.run();
    expect(asked(f, 'left')).toBe(1);
    expect(asked(f, 'zed')).toBe(0);
  });

  it('has no evidence at all when no scorer of ours has a camera on', () => {
    const f = meshFixture();
    f.peers.find((peer) => peer.peerId === 'camera')!.cameraOn = false;
    const evidence = render(() => useDartEvidence({ mesh: f.mesh, links: f.mesh.links(), matchId: 'match',
      boardId: 'board', isThrower: true, enabled: true,
      currentVisit: { id: 'visit', playerId: 'thrower', locked: false, darts: [{ ...makeDart('S20'), id: 'dart' }] } }));
    expect(evidence.available).toBe(false);
    expect(f.wires.get('camera')!.sendControl).not.toHaveBeenCalled();
  });

  it('asks again of the next scorer when the one asked leaves the roster', () => {
    const f = setup(true, { extra: [ownScorer('left', 'Left')], dart: placedBy('Left') });
    expect(asked(f, 'left')).toBe(1);
    f.peers.splice(f.peers.findIndex((peer) => peer.peerId === 'left'), 1);
    f.wires.delete('left');
    f.options.links = f.mesh.links();
    f.run();
    expect(asked(f, 'camera')).toBe(1);
  });

  it('falls back when the live camera stops without losing its link, and takes a picture already on its way', () => {
    const f = setup(true, { extra: [ownScorer('left', 'Left')] });
    f.peers.find((peer) => peer.peerId === 'camera')!.cameraOn = false;
    f.options.links = f.mesh.links();
    f.run();
    expect(asked(f, 'left')).toBe(1);
    // The stopped camera's picture was sent before it stopped. Everyone else takes it, so the
    // thrower does too — and then the fallback's is a duplicate.
    f.run().handleControl('camera', f.response, bytes);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    const leftRequest = f.wires.get('left')!.sendControl.mock.calls[0][0] as { id: string };
    f.run().handleControl('left', { ...f.response, id: leftRequest.id }, bytes);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it('falls back on a matching refusal without looping, and clears refusals on dart replacement', () => {
    const f = setup(true, { extra: [ownScorer('left', 'Left')], dart: placedBy('Left') });
    const leftRequest = f.wires.get('left')!.sendControl.mock.calls[0][0] as { id: string };
    const refusal: ControlMessage = { kind: 'still_refused', id: leftRequest.id, reason: 'no_frame' };
    f.run().handleControl('camera', refusal); // wrong sender
    f.run().handleControl('left', { ...refusal, id: 'stale' });
    f.run();
    expect(asked(f, 'camera')).toBe(0);
    f.run().handleControl('left', refusal);
    f.run();
    expect(asked(f, 'camera')).toBe(1);
    const cameraRequest = f.wires.get('camera')!.sendControl.mock.calls[0][0] as { id: string };
    f.run().handleControl('camera', { ...refusal, id: cameraRequest.id });
    f.run();
    f.options.links = f.mesh.links();
    f.run();
    expect(asked(f, 'left')).toBe(1);
    expect(asked(f, 'camera')).toBe(1);
    f.options.currentVisit = { ...f.options.currentVisit, darts: [{ ...f.options.currentVisit.darts[0], id: 'replacement' }] };
    f.run();
    expect(asked(f, 'left')).toBe(2);
  });

  describe('after a refusal', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    /** The scorer refuses the last request it was sent, and the hook renders again. */
    function refuseLatest(f: ReturnType<typeof setup>, peerId: string) {
      const calls = f.wires.get(peerId)!.sendControl.mock.calls;
      const request = calls[calls.length - 1][0] as { id: string };
      f.run().handleControl(peerId, { kind: 'still_refused', id: request.id, reason: 'not_located' });
      f.run();
    }

    it('asks the same scorer again once its back-off is over, and not after three refusals', () => {
      const f = setup(true);
      refuseLatest(f, 'camera');
      expect(asked(f, 'camera')).toBe(1); // left alone while it backs off
      vi.advanceTimersByTime(1500);
      f.run();
      expect(asked(f, 'camera')).toBe(2);
      refuseLatest(f, 'camera');
      vi.advanceTimersByTime(1500);
      f.run();
      expect(asked(f, 'camera')).toBe(3);
      refuseLatest(f, 'camera');
      vi.advanceTimersByTime(60_000);
      f.run();
      expect(asked(f, 'camera')).toBe(3);
    });

    it('asks again when the back-off timer fires, whatever the wall clock says', () => {
      const f = setup(true);
      refuseLatest(f, 'camera');
      vi.setSystemTime(Date.now() - 60_000); // the clock is stepped back meanwhile
      vi.advanceTimersByTime(1500);
      f.run();
      expect(asked(f, 'camera')).toBe(2);
    });

    it('does not hold a camera back for a refusal it sent while stopping', () => {
      const f = setup(true);
      const camera = f.peers.find((peer) => peer.peerId === 'camera')!;
      camera.cameraOn = false;
      f.options.links = f.mesh.links();
      f.run();
      // The phone's answer to the request its stop dropped arrives after the roster said so.
      refuseLatest(f, 'camera');
      camera.cameraOn = true;
      f.options.links = f.mesh.links();
      f.run();
      expect(asked(f, 'camera')).toBe(2);
    });

    it('gives a camera that stopped and came back a clean record', () => {
      const f = setup(true);
      for (let refusal = 0; refusal < 3; refusal++) {
        refuseLatest(f, 'camera');
        vi.advanceTimersByTime(1500);
        f.run();
      }
      expect(asked(f, 'camera')).toBe(3);
      const camera = f.peers.find((peer) => peer.peerId === 'camera')!;
      camera.cameraOn = false;
      f.options.links = f.mesh.links();
      f.run();
      camera.cameraOn = true;
      f.options.links = f.mesh.links();
      f.run();
      expect(asked(f, 'camera')).toBe(4);
    });
  });

  it('times the round trip from the request that was answered, not the latest', () => {
    e2e.enabled = true;
    try {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
      const f = setup(true, { extra: [ownScorer('left', 'Left')] });
      now.mockReturnValue(1100);
      f.peers.find((peer) => peer.peerId === 'camera')!.cameraOn = false;
      f.options.links = f.mesh.links();
      f.run();
      expect(asked(f, 'left')).toBe(1);
      now.mockReturnValue(1150);
      f.run().handleControl('camera', f.response, bytes);
      expect(f.run().timings.current).toEqual([{ dart: 0, roundTripMs: 150, bytes: bytes.byteLength }]);
    } finally {
      e2e.enabled = false;
    }
  });

  it('takes the answer only from the scorer it asked', () => {
    const f = setup(true, { extra: [ownScorer('left', 'Left')], dart: placedBy('Left') });
    const request = f.wires.get('left')!.sendControl.mock.calls[0][0] as { id: string };
    f.run().handleControl('camera', { ...f.response, id: request.id }, bytes);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    f.run().handleControl('left', { ...f.response, id: request.id }, bytes);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it('lets an observer take the picture from any scorer at the thrower\'s board', () => {
    const f = setup(false, { extra: [ownScorer('left', 'Left', { own: false, role: 'opponent' })] });
    f.run().handleControl('left', f.response, bytes);
    expect(f.run().images[0]).toMatch(/^blob:/);
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

  it.each([
    { reason: 'restarted', next: {}, removeSource: false },
    { reason: 'no_frame', next: null, removeSource: false },
    { reason: 'no_frame', next: null, removeSource: true },
  ] as const)('tells the owner $reason when the stream changes (missing source: $removeSource)', async ({ reason, next, removeSource }) => {
    const f = meshFixture();
    let resolve!: (value: Capture) => void;
    const pending = new Promise<Capture>((done) => { resolve = done; });
    let sourceIdentity: object | null = {};
    const source = { capture: vi.fn(() => pending), located: () => true, identity: () => sourceIdentity };
    const sourceRef = { current: source as typeof source | null };
    const responder = render(() => useStillResponder({ current: f.mesh }, sourceRef));
    responder.handleControl('owner', { kind: 'still_request', id: 'one', to: ['owner'] });
    responder.handleControl('owner', { kind: 'still_request', id: 'two', to: ['owner'] });
    // A camera restart is a new stream; stopping may also remove the source wrapper entirely.
    sourceIdentity = next;
    if (removeSource) sourceRef.current = null;
    resolve({ blob: new Blob(['jpeg']), timing: { drawMs: 0, encodeMs: 0 } });
    const send = f.wires.get('owner')!.sendControl;
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(([message]) => message)).toEqual(['one', 'two'].map((id) =>
      ({ kind: 'still_refused', id, reason })));
    expect(source.capture).toHaveBeenCalledTimes(1);
  });

  it('answers a capture that failed outright, and goes on with the queue', async () => {
    const f = meshFixture();
    const identity = {};
    const source = {
      capture: vi.fn()
        .mockRejectedValueOnce(new Error('EncodingError'))
        .mockResolvedValueOnce({ blob: new Blob(['jpeg']), timing: { drawMs: 0, encodeMs: 0 } }),
      located: () => true,
      identity: () => identity,
    };
    const responder = render(() => useStillResponder({ current: f.mesh }, { current: source }));
    responder.handleControl('owner', { kind: 'still_request', id: 'one', to: ['owner'] });
    responder.handleControl('owner', { kind: 'still_request', id: 'two', to: ['owner'] });
    const send = f.wires.get('owner')!.sendControl;
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { kind: 'still_refused', id: 'one', reason: 'no_frame' },
      expect.objectContaining({ kind: 'still', id: 'two' }),
    ]);
  });

  it.each(['mesh', 'owner', 'link'])('drops active and queued work in silence when its %s changes', async (change) => {
    const f = meshFixture();
    let resolve!: (value: Capture) => void;
    const pending = new Promise<Capture>((done) => { resolve = done; });
    const sourceIdentity = {};
    const source = { capture: vi.fn(() => pending), located: () => true, identity: () => sourceIdentity };
    const sourceRef = { current: source };
    const meshRef = { current: f.mesh };
    const responder = render(() => useStillResponder(meshRef, sourceRef));
    responder.handleControl('owner', { kind: 'still_request', id: 'one', to: ['owner'] });
    responder.handleControl('owner', { kind: 'still_request', id: 'two', to: ['owner'] });
    const originalLink = f.wires.get('owner')!;
    if (change === 'mesh') meshRef.current = meshFixture().mesh;
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
