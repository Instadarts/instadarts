import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMatch } from '../../src/client/hooks/useMatch';
import { clearReconnectInfo } from '../../src/client/lib/ws';

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
vi.mock('../../src/client/lib/ws', () => ({ clearReconnectInfo: vi.fn(), saveReconnectInfo: vi.fn() }));

function render() {
  harness.cursor = 0;
  return useMatch();
}

beforeEach(() => {
  harness.slots = [];
  vi.clearAllMocks();
  render();
  harness.receive({ type: 'match_state', match: { id: 'old', players: [] }, view: {}, panel: {},
    yourPlayerIds: ['alice'], youAreSpectator: false, mediaDisabled: true });
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
