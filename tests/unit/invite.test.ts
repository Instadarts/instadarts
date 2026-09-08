import { afterEach, describe, expect, it, vi } from 'vitest';
import '../helpers';
import { generateInviteCode, generatePersonalInvite, findPersonalInvite } from '../../src/server/invite';
import { createLobby, deleteLobby, findLobbyByInviteCode, getAllLobbies, setLobbyInviteCode } from '../../src/server/store';

const randomInt = vi.hoisted(() => vi.fn<(max: number) => number>());
vi.mock('node:crypto', async (original) => ({
  ...await original<typeof import('node:crypto')>(),
  randomInt,
}));

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Feed the same finite candidate sequence to the old and new randomness sources, so collision
// tests reproduce the routing bug before the fix and exercise retries afterward.
function candidates(...codes: string[]) {
  const values = codes.join('').split('').map((char) => alphabet.indexOf(char));
  let cursor = 0;
  const next = () => {
    if (cursor >= values.length) throw new Error('Unexpected extra invite candidate');
    return values[cursor++];
  };
  vi.spyOn(Math, 'random').mockImplementation(() => next() / alphabet.length);
  randomInt.mockImplementation((max) => {
    expect(max).toBe(alphabet.length);
    return next();
  });
}

afterEach(() => {
  for (const id of getAllLobbies().keys()) deleteLobby(id);
  vi.restoreAllMocks();
  randomInt.mockReset();
});

describe('lobby invite generation', () => {
  it('retries repeated collisions so each returned code resolves to its own lobby', () => {
    candidates('AAAAAA', 'AAAAAA', 'AAAAAA', 'BBBBBB');
    const first = createLobby();
    const second = createLobby();
    const firstCode = generateInviteCode(first.id);
    const secondCode = generateInviteCode(second.id);
    expect(findLobbyByInviteCode(secondCode)).toBe(second);
    expect(secondCode).toBe('BBBBBB');
    expect(findLobbyByInviteCode(firstCode)).toBe(first);
    expect(first.inviteCode).toBe('AAAAAA');
  });

  it('rotates past its own old code and codes held by other lobbies', () => {
    const lobby = createLobby();
    const other = createLobby();
    setLobbyInviteCode(lobby.id, 'AAAAAA');
    setLobbyInviteCode(other.id, 'BBBBBB');
    candidates('AAAAAA', 'BBBBBB', 'CCCCCC');
    expect(generateInviteCode(lobby.id)).toBe('CCCCCC');
    expect(findLobbyByInviteCode('AAAAAA')).toBeUndefined();
    expect(findLobbyByInviteCode('BBBBBB')).toBe(other);
    expect(findLobbyByInviteCode('CCCCCC')).toBe(lobby);
  });

  it('shares the collision namespace with personal codes and retires them on lobby deletion', () => {
    const ordinary = createLobby();
    const managed = createLobby();
    setLobbyInviteCode(ordinary.id, 'AAAAAA');
    candidates('AAAAAA', 'BBBBBB', 'BBBBBB', 'CCCCCC', 'BBBBBB', 'CCCCCC', 'DDDDDD');
    expect(generatePersonalInvite(managed.id, 'player-1')).toBe('BBBBBB');
    expect(generatePersonalInvite(managed.id, 'player-2')).toBe('CCCCCC');
    expect(generateInviteCode(ordinary.id)).toBe('DDDDDD');
    expect(findPersonalInvite('BBBBBB')).toEqual({ lobbyId: managed.id, playerId: 'player-1' });
    deleteLobby(managed.id);
    expect(findPersonalInvite('BBBBBB')).toBeUndefined();
    expect(findPersonalInvite('CCCCCC')).toBeUndefined();
    candidates('BBBBBB');
    expect(generateInviteCode(ordinary.id)).toBe('BBBBBB');
  });

  it('uses cryptographic random indices without falling back to Math.random', () => {
    candidates('A9A9A9');
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Insecure randomness'); });
    const lobby = createLobby();
    expect(generateInviteCode(lobby.id)).toBe('A9A9A9');
    expect(randomInt).toHaveBeenCalledTimes(6);
    expect(findLobbyByInviteCode('A9A9A9')).toBe(lobby);
  });

  it('can reuse a code after its lobby has been deleted', () => {
    const deleted = createLobby();
    setLobbyInviteCode(deleted.id, 'AAAAAA');
    deleteLobby(deleted.id);
    const lobby = createLobby();
    candidates('AAAAAA');
    expect(generateInviteCode(lobby.id)).toBe('AAAAAA');
    expect(findLobbyByInviteCode('AAAAAA')).toBe(lobby);
  });

  it('returns null for a missing lobby without changing an existing invite', () => {
    const lobby = createLobby();
    setLobbyInviteCode(lobby.id, 'AAAAAA');
    candidates('BBBBBB');
    expect(generateInviteCode('missing')).toBeNull();
    expect(findLobbyByInviteCode('AAAAAA')).toBe(lobby);
    expect(findLobbyByInviteCode('BBBBBB')).toBeUndefined();
  });
});
