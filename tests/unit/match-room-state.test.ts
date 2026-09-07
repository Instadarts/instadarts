import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMatch } from '../../src/client/hooks/useMatch';
import * as reconnectStorage from '../../src/client/lib/ws';
import { clearReconnectInfo, loadReconnectInfo } from '../../src/client/lib/ws';

// Run this hook's synchronous state/message logic without a browser or a transport. Slot values
// survive render() calls; effects and DOM behavior are outside these tests.
const harness = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, receive: (_message: any) => {}, send: vi.fn() }));
vi.mock('react', () => ({
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (index >= harness.slots.length) harness.slots.push(initial);
    return [harness.slots[index], (value: unknown) => {
      harness.slots[index] = typeof value === 'function' ? value(harness.slots[index]) : value;
    }];
  },
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
}));
vi.mock('../../src/client/hooks/useWebSocket', () => ({
  useWebSocket(receive: typeof harness.receive) {
    harness.receive = receive;
    return { send: harness.send, connected: true, generation: 1, sessionId: 'client' };
  },
}));

function render() {
  harness.cursor = 0;
  return useMatch();
}

beforeEach(() => {
  harness.slots = [];
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.spyOn(reconnectStorage, 'clearReconnectInfo');
  render();
  harness.receive({ type: 'match_state', match: { id: 'old', players: [] }, view: {}, panel: {},
    yourPlayerIds: ['alice'], youAreSpectator: false, mediaDisabled: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('client room transitions', () => {
  it('keeps its current role and credentials when a spectate request is refused', () => {
    render().spectate('missing');
    harness.receive({ type: 'error', message: 'Lobby or match not found' });
    expect(clearReconnectInfo).not.toHaveBeenCalled();
    expect(render().isSpectator).toBe(false);
    expect(render().match?.id).toBe('old');
    expect(render().ownPlayerIds).toEqual(['alice']);
  });

  it('drops the old match state when a lobby is accepted', () => {
    harness.receive({ type: 'lobby_state', lobby: { id: 'new', players: [] },
      yourPlayerIds: [], youAreHost: true, youAreSpectator: false });
    expect(render()).toMatchObject({ lobby: { id: 'new' }, match: null, view: null,
      panel: undefined, mediaDisabled: false, ownPlayerIds: [], isHost: true });
  });

  it.each(['lobby_state', 'match_state'])('clears participant credentials and ownership on an accepted %s spectator reply', (type) => {
    render().spectate('new');
    vi.mocked(clearReconnectInfo).mockClear();
    harness.receive({ type, lobby: { id: 'new', players: [] }, match: { id: 'new', players: [] },
      youAreSpectator: true });
    expect(clearReconnectInfo).toHaveBeenCalledOnce();
    expect(render().isSpectator).toBe(true);
    expect(render().ownPlayerIds).toEqual([]);
    expect(render().isHost).toBe(false);
  });
});

describe('summary reconnect credentials', () => {
  const resume = { type: 'resume', matchId: 'old', token: 'private-seat-token' };
  const finished = { id: 'old', status: 'finished', players: [] };

  it.each(['match_finished', 'match_state'])('retains the saved seat when a summary arrives through %s', (type) => {
    harness.receive(resume);
    harness.receive({ type, match: finished, view: {}, panel: {} });
    // This is the real storage reader used by the replacement socket's onopen callback.
    expect(loadReconnectInfo()).toEqual({ matchId: 'old', token: resume.token });
    expect(render().match).toEqual(finished);
    expect(render().ownPlayerIds).toEqual(['alice']);
    expect(render().isSpectator).toBe(false);
  });

  it('keeps the summary credential across a page reload that discards hook state', () => {
    harness.receive(resume);
    harness.receive({ type: 'match_finished', match: finished });
    harness.slots = [];
    expect(render().match).toBeNull();
    expect(loadReconnectInfo()).toEqual({ matchId: 'old', token: resume.token });
  });

  it.each(['leave', 'seat_taken_over', 'lobby_abandoned', 'match_closed'])(
    'still clears the credential on %s', (ending) => {
      harness.receive(resume);
      if (ending === 'leave') render().leaveMatch();
      else harness.receive({ type: ending });
      expect(loadReconnectInfo()).toBeNull();
    },
  );

  it('replaces the saved room when the rematch resume arrives', () => {
    harness.receive(resume);
    harness.receive({ type: 'match_finished', match: finished });
    harness.receive({ type: 'resume', matchId: 'rematch', token: resume.token });
    harness.receive({ type: 'match_started', match: { id: 'rematch', players: [] },
      yourPlayerIds: ['alice'], youAreSpectator: false });
    expect(loadReconnectInfo()).toEqual({ matchId: 'rematch', token: resume.token });
  });

  it('does not invent a credential for a spectator receiving the summary', () => {
    harness.receive({ type: 'match_state', match: finished, youAreSpectator: true });
    harness.receive({ type: 'match_finished', match: finished });
    expect(loadReconnectInfo()).toBeNull();
    expect(render().isSpectator).toBe(true);
  });
});
