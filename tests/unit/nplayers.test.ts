import { describe, it, expect, beforeEach } from 'vitest';
import type { WebSocket } from 'ws';
import '../helpers';
import '../../src/server/modes/count-up';
import { handleMessage, registerClient } from '../../src/server/wsHandler';
import { getLobby, createRematch } from '../../src/server/store';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { resetDeviceRegistry } from '../../src/server/devices';
import { nextActiveIndex } from '../../src/server/match';
import { publicPlayers } from '../../src/server/connections';
import { heldSeat, revokeSeat } from '../../src/server/seats';
import type { ServerMessage } from '../../src/shared/protocol';
import type { Player } from '../../src/shared/types';
import { makeMatch, playVisit } from '../helpers';

let sessionCounter = 0;

function connect() {
  const sessionId = `nplayer-session-${++sessionCounter}`;
  const received: (ServerMessage | { type: 'connected'; sessionId: string })[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;
  registerClient(ws, {
    sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null,
  });

  return {
    ws, sessionId, received,
    send(message: object) {
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(message));
    },
    last<T extends ServerMessage['type']>(type: T) {
      return received.filter((message) => message.type === type).at(-1) as
        Extract<ServerMessage, { type: T }> | undefined;
    },
    all<T extends ServerMessage['type']>(type: T) {
      return received.filter((message) => message.type === type) as
        Extract<ServerMessage, { type: T }>[];
    },
    resumeToken() { return this.last('resume')?.token; },
    spectator(): boolean | undefined {
      for (let i = received.length - 1; i >= 0; i--) {
        const m = received[i];
        if ((m.type === 'lobby_state' || m.type === 'match_state' || m.type === 'match_started')
          && m.youAreSpectator !== undefined) {
          return m.youAreSpectator;
        }
      }
      return undefined;
    },
    playerIds(): string[] {
      for (let i = received.length - 1; i >= 0; i--) {
        const m = received[i];
        if ((m.type === 'lobby_state' || m.type === 'match_state' || m.type === 'match_started') && m.yourPlayerIds) {
          return m.yourPlayerIds;
        }
      }
      return [];
    },
  };
}

beforeEach(() => {
  resetDeviceRegistry();
});

describe('n-players lobby & roster management', () => {
  it('allows adding up to 5 players in count-up local lobby', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: false });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'update_settings', lobbyId, settings: { mode: 'count-up' } });

    for (let i = 1; i <= 5; i++) {
      host.send({ type: 'add_local_player', lobbyId, playerName: `Player ${i}` });
      expect(host.last('lobby_state')!.lobby.players).toHaveLength(i);
    }

    // 6th player should be rejected (default server cap is 5)
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Player 6' });
    expect(host.last('error')?.message).toBe('Lobby is full');
    expect(host.last('lobby_state')!.lobby.players).toHaveLength(5);
  });

  it('rejects switching to a 2-player mode when lobby has 3+ players', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: false });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'update_settings', lobbyId, settings: { mode: 'count-up' } });

    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Carol' });
    expect(host.last('lobby_state')!.lobby.players).toHaveLength(3);

    host.send({ type: 'update_settings', lobbyId, settings: { mode: 'x01' } });
    expect(host.last('error')?.message).toContain('takes at most 2 players');
    expect(getLobby(lobbyId)!.settings.mode).toBe('count-up');
  });

  it('refuses a name the lobby already has, and lets a player keep its own', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: false });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'update_settings', lobbyId, settings: { mode: 'count-up' } });
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });

    // The browser has always refused this; the server used to take it, and `set_player_name` has no
    // UI at all, so a rename could only ever arrive this way.
    host.send({ type: 'add_local_player', lobbyId, playerName: '  alice  ' });
    expect(host.last('error')?.message).toBe('That name is already taken');
    expect(getLobby(lobbyId)!.players).toHaveLength(1);

    const alice = getLobby(lobbyId)!.players[0];
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
    const bob = getLobby(lobbyId)!.players[1];

    host.send({ type: 'set_player_name', lobbyId, playerId: bob.id, name: 'Alice' });
    expect(host.last('error')?.message).toBe('That name is already taken');
    expect(getLobby(lobbyId)!.players[1].name).toBe('Bob');

    // Renaming a player to what it is already called is a no-op, not a refusal.
    host.send({ type: 'set_player_name', lobbyId, playerId: alice.id, name: 'Alice' });
    expect(getLobby(lobbyId)!.players[0].name).toBe('Alice');
  });

  it('supports reordering players with reorder_player', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: false });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'update_settings', lobbyId, settings: { mode: 'count-up' } });

    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Carol' });

    const p = host.last('lobby_state')!.lobby.players;
    const [alice, bob, carol] = p;

    // Move Carol up
    host.send({ type: 'reorder_player', lobbyId, playerId: carol.id, direction: 'up' });
    let players = host.last('lobby_state')!.lobby.players;
    expect(players.map((x) => x.name)).toEqual(['Alice', 'Carol', 'Bob']);

    // Move Carol up again to top
    host.send({ type: 'reorder_player', lobbyId, playerId: carol.id, direction: 'up' });
    players = host.last('lobby_state')!.lobby.players;
    expect(players.map((x) => x.name)).toEqual(['Carol', 'Alice', 'Bob']);

    // Move Carol up at top (no-op)
    host.send({ type: 'reorder_player', lobbyId, playerId: carol.id, direction: 'up' });
    players = host.last('lobby_state')!.lobby.players;
    expect(players.map((x) => x.name)).toEqual(['Carol', 'Alice', 'Bob']);

    // Move Carol down
    host.send({ type: 'reorder_player', lobbyId, playerId: carol.id, direction: 'down' });
    players = host.last('lobby_state')!.lobby.players;
    expect(players.map((x) => x.name)).toEqual(['Alice', 'Carol', 'Bob']);
  });
});

describe('multi-player per online connection', () => {
  it('allows multiple players per online user and tracks ownPlayerIds', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'update_settings', lobbyId, settings: { mode: 'count-up' } });

    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Carol' });
    expect(host.playerIds()).toHaveLength(2);

    const inviteCode = host.last('lobby_state')!.lobby.inviteCode!;
    const guest = connect();
    guest.send({ type: 'join_lobby', inviteCode });
    guest.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
    guest.send({ type: 'add_local_player', lobbyId, playerName: 'Dave' });
    expect(guest.playerIds()).toHaveLength(2);

    const lobby = getLobby(lobbyId)!;
    expect(lobby.players).toHaveLength(4);

    // Board IDs: Alice and Carol share host's boardId; Bob and Dave share guest's boardId
    const pub = publicPlayers(lobby.players);
    expect(pub[0].name).toBe('Alice');
    expect(pub[0].boardId).toBe(pub[0].id);
    expect(pub[1].name).toBe('Carol');
    expect(pub[1].boardId).toBe(pub[0].id);

    expect(pub[2].name).toBe('Bob');
    expect(pub[2].boardId).toBe(pub[2].id);
    expect(pub[3].name).toBe('Dave');
    expect(pub[3].boardId).toBe(pub[2].id);
  });
});

describe('n-players turn rotation & leaver rule', () => {
  it('nextActiveIndex advances around active players skipping departed ones', () => {
    const match = makeMatch({
      players: [
        { id: 'p1', name: 'P1', sessionId: 's1' },
        { id: 'p2', name: 'P2', sessionId: 's2' },
        { id: 'p3', name: 'P3', sessionId: 's3' },
      ],
      currentPlayerIndex: 0,
      departed: ['p2'],
    });

    // From p1 (0) -> next active should be p3 (2), skipping departed p2 (1)
    expect(nextActiveIndex(match, 0)).toBe(2);
    // From p3 (2) -> next active should be p1 (0)
    expect(nextActiveIndex(match, 2)).toBe(0);
  });

  it('3-player online match continues when 1 player leaves, and finishes when 2nd leaves', () => {
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'update_settings', lobbyId, settings: { mode: 'count-up' } });
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    const inviteCode = host.last('lobby_state')!.lobby.inviteCode!;

    const guest1 = connect();
    guest1.send({ type: 'join_lobby', inviteCode });
    guest1.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });

    const guest2 = connect();
    guest2.send({ type: 'join_lobby', inviteCode });
    guest2.send({ type: 'add_local_player', lobbyId, playerName: 'Carol' });

    host.send({ type: 'start_match', lobbyId });
    const match = host.last('match_started')!.match;
    expect(match.players).toHaveLength(3);
    expect(match.status).toBe('in_progress');

    // Alice is up (index 0). Alice leaves the match.
    host.send({ type: 'leave_match', matchId: match.id });

    // Match should still be in_progress for guest1 and guest2!
    const stateBob = guest1.last('match_state')!.match;
    expect(stateBob.status).toBe('in_progress');
    expect(stateBob.departed).toContain(match.players[0].id);
    expect(stateBob.currentPlayerIndex).toBe(1); // advanced to Bob

    // Now Bob leaves as well -> only Carol remains, so Carol wins!
    guest1.send({ type: 'leave_match', matchId: match.id });
    const finishedCarol = guest2.last('match_finished')!.match;
    expect(finishedCarol.status).toBe('finished');
    expect(finishedCarol.winnerId).toBe(match.players[2].id);
  });
});

describe('a leg with five players', () => {
  it('goes round the whole roster and ends when one of them gets there', () => {
    // count-up, first to 200: five visits of T20 is 180, so nobody wins on the first lap and the
    // rota has to come back round. The match layer is what is under test here — the rotation and
    // the win — not the mode's arithmetic.
    const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];
    let match = makeMatch({
      settings: { mode: 'count-up', targetScore: 200 } as never,
      players: names.map((name, i) => ({ id: `p${i + 1}`, name, sessionId: `s${i + 1}` })),
    });

    const order: string[] = [];
    for (let visit = 0; visit < 10 && match.status === 'in_progress'; visit++) {
      const up = match.players[match.currentPlayerIndex];
      order.push(up.name);
      match = playVisit(match, up.id, ['T20', 'T20', 'T20']);
    }

    // One full lap in roster order, then round again — no player skipped, none taken twice.
    expect(order.slice(0, 5)).toEqual(names);
    expect(order[5]).toBe('Alice');
    // Alice reaches 360 on her second visit and takes the leg, and with it the match.
    expect(match.status).toBe('finished');
    expect(match.winnerId).toBe('p1');
  });
});

describe('n-players rematch rotation', () => {
  it('rotates players by one on rematch', () => {
    const p1: Player = { id: 'p1', name: 'Alice', sessionId: 's1' };
    const p2: Player = { id: 'p2', name: 'Bob', sessionId: 's2' };
    const p3: Player = { id: 'p3', name: 'Carol', sessionId: 's3' };

    const match = makeMatch({
      players: [p1, p2, p3],
      status: 'finished',
    });

    const rematch = createRematch(match);
    expect(rematch.players.map((p) => p.name)).toEqual(['Bob', 'Carol', 'Alice']);

    const rematch2 = createRematch(rematch);
    expect(rematch2.players.map((p) => p.name)).toEqual(['Carol', 'Alice', 'Bob']);
  });
});

/**
 * An online count-up lobby, one connection per user, each adding the names listed for it. count-up
 * is the mode that takes more than two players, which is what every shape below needs.
 */
function onlineLobby(names: string[][]) {
  const host = connect();
  host.send({ type: 'create_lobby', acceptsJoins: true });
  const lobbyId = host.last('lobby_state')!.lobby.id;
  host.send({ type: 'update_settings', lobbyId, settings: { mode: 'count-up' } });
  const inviteCode = host.last('lobby_state')!.lobby.inviteCode!;
  const users: ReturnType<typeof connect>[] = [];
  for (const [index, mine] of names.entries()) {
    const user = index === 0 ? host : connect();
    if (index > 0) user.send({ type: 'join_lobby', inviteCode });
    users.push(user);
    for (const name of mine) user.send({ type: 'add_local_player', lobbyId, playerName: name });
  }
  return { host, users, lobbyId, inviteCode };
}

describe('who holds a player', () => {
  it('the host kicks somebody else\'s player, and it is taken off the owner rather than the host', () => {
    const { host, users, lobbyId } = onlineLobby([['Alice'], ['Bob', 'Dave']]);
    const [, guest] = users;
    const bob = getLobby(lobbyId)!.players.find((p) => p.name === 'Bob')!;

    host.send({ type: 'remove_player', lobbyId, playerId: bob.id });

    // Off the roster, off the owner's list, and off the owner's seat — the three places a player
    // is held. Editing the remover's copies instead is what used to leave a ghost behind.
    expect(getLobby(lobbyId)!.players.map((p) => p.name)).toEqual(['Alice', 'Dave']);
    expect(guest.playerIds()).toEqual([getLobby(lobbyId)!.players[1].id]);
    expect(heldSeat(lobbyId, guest.sessionId)!.seat.playerIds).toEqual([getLobby(lobbyId)!.players[1].id]);
    // And the host still holds exactly what it held.
    expect(host.playerIds()).toEqual([getLobby(lobbyId)!.players[0].id]);
  });

  it('a user kicked down to nothing starts the match as a spectator, and is told so', () => {
    const { host, users, lobbyId } = onlineLobby([['Alice', 'Carol'], ['Bob']]);
    const [, guest] = users;
    const bob = getLobby(lobbyId)!.players.find((p) => p.name === 'Bob')!;

    host.send({ type: 'remove_player', lobbyId, playerId: bob.id });
    host.send({ type: 'start_match', lobbyId });

    const match = host.last('match_started')!.match;
    expect(match.players.map((p) => p.name)).toEqual(['Alice', 'Carol']);
    // No ghost: Bob is nowhere in the roster that just froze.
    expect(match.players.some((p) => p.id === bob.id)).toBe(false);
    // The guest is in the room but not in the match, and its own tab is told rather than left to
    // work it out from a match that names nobody's role.
    expect(guest.spectator()).toBe(true);
    expect(host.spectator()).toBe(false);
  });

  it('a user who never added a player becomes a spectator at start', () => {
    const { host, users, lobbyId } = onlineLobby([['Alice', 'Carol'], []]);
    const [, watcher] = users;

    host.send({ type: 'start_match', lobbyId });

    expect(host.last('match_started')!.match.players).toHaveLength(2);
    expect(watcher.spectator()).toBe(true);
    // Seat given up with the place: a spectator cannot act on the match it is watching.
    expect(heldSeat(host.last('match_started')!.match.id, watcher.sessionId)).toBeNull();
  });

  it('re-announcing a connection to its lobby keeps the players it already added', () => {
    const { users, lobbyId } = onlineLobby([['Alice'], ['Bob']]);
    const [, guest] = users;
    const before = guest.playerIds();
    expect(before).toHaveLength(1);

    // A tab that lands on the join URL a second time is re-announcing itself, not arriving. Its
    // players used to be orphaned here — left on the roster, owned by nobody.
    guest.send({ type: 'join_lobby', inviteCode: getLobby(lobbyId)!.inviteCode! });

    expect(guest.playerIds()).toEqual(before);
    expect(heldSeat(lobbyId, guest.sessionId)!.seat.playerIds).toEqual(before);
  });

  it('drops a player no seat holds before the roster freezes', () => {
    const { host, users, lobbyId } = onlineLobby([['Alice', 'Carol'], ['Bob']]);
    const [, guest] = users;
    // However an orphan came about — this is the shape of every way it can — the seat is the
    // owner of record, so a player nobody holds does not get to play.
    revokeSeat(lobbyId, guest.sessionId);

    host.send({ type: 'start_match', lobbyId });

    const match = host.last('match_started')!.match;
    expect(match.players.map((p) => p.name)).toEqual(['Alice', 'Carol']);
  });

  it('keeps the players of a tab that is merely mid-reload', () => {
    const { host, users, lobbyId } = onlineLobby([['Alice'], ['Bob']]);
    const [, guest] = users;
    const seat = heldSeat(lobbyId, guest.sessionId)!;

    // The socket closed; within the grace the client record is what a reload replaces, but the
    // seat is untouched — which is exactly why reconciling is asked of the seats.
    guest.ws.readyState = 3 as unknown as typeof guest.ws.readyState;
    const returning = connect();
    returning.send({ type: 'reconnect', lobbyId, token: seat.token });

    host.send({ type: 'start_match', lobbyId });
    expect(host.last('match_started')!.match.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);
    expect(returning.spectator()).toBe(false);
  });

  it('brings back every player on a reloaded seat, not just the first', () => {
    const { host, users, lobbyId } = onlineLobby([['Alice'], ['Bob', 'Dave']]);
    const [, guest] = users;
    host.send({ type: 'start_match', lobbyId });
    const match = host.last('match_started')!.match;
    const mine = guest.playerIds();
    expect(mine).toHaveLength(2);

    const returning = connect();
    returning.send({ type: 'reconnect', matchId: match.id, token: guest.resumeToken() });

    expect(returning.playerIds()).toEqual(mine);
    expect(returning.spectator()).toBe(false);
  });
});

describe('how many users a lobby takes', () => {
  it('refuses a user who could never take a place', () => {
    // x01 caps itself at two players, so it caps the lobby at two users: a third could only ever
    // sit there unable to add anybody.
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    const inviteCode = host.last('lobby_state')!.lobby.inviteCode!;
    const guest = connect();
    guest.send({ type: 'join_lobby', inviteCode });

    const third = connect();
    third.send({ type: 'join_lobby', inviteCode });
    expect(third.last('error')?.message).toBe('Lobby is full');
    expect(guest.last('error')).toBeUndefined();
  });

  it('tells the lobby what its cap is, how many users are in it, and whether it still admits one', () => {
    const { host, lobbyId } = onlineLobby([['Alice'], ['Bob']]);
    const lobby = host.last('lobby_state')!.lobby;
    expect(lobby.id).toBe(lobbyId);
    expect(lobby.maxPlayers).toBe(5);
    expect(lobby.userCount).toBe(2);
    // The screen is told the answer rather than handed the numbers to re-derive it from.
    expect(lobby.admitting).toBe(true);
  });

  it('stops admitting once the roster is full, and says so', () => {
    const { host, lobbyId } = onlineLobby([['Alice', 'Bob', 'Carol', 'Dave', 'Eve']]);
    expect(host.last('lobby_state')!.lobby.admitting).toBe(false);

    const sixth = connect();
    sixth.send({ type: 'join_lobby', inviteCode: getLobby(lobbyId)!.inviteCode! });
    expect(sixth.last('error')?.message).toBe('Lobby is full');
  });

  it('a lobby that admits nobody says so too', () => {
    const host = connect();
    host.send({ type: 'create_lobby' });
    expect(host.last('lobby_state')!.lobby.admitting).toBe(false);
  });
});
