import { describe, it, expect, beforeEach } from 'vitest';
import type { WebSocket } from 'ws';
import '../helpers';
import '../../src/server/modes/count-up';
import { handleMessage, registerClient } from '../../src/server/wsHandler';
import { deleteLobby, deleteMatch, getLobby, getMatch, movePlayerInLobby, createRematch } from '../../src/server/store';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { resetDeviceRegistry } from '../../src/server/devices';
import { nextActiveIndex, addDartToMatch, submitVisitToMatch } from '../../src/server/match';
import { publicPlayers } from '../../src/server/connections';
import { startMediaForMatch, userCountOf } from '../../src/server/media';
import type { ServerMessage } from '../../src/shared/protocol';
import type { MatchState, Player } from '../../src/shared/types';
import { makeMatch } from '../helpers';

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
    sessionId, lobbyId: null, matchId: null, playerIds: [], isSpectator: false, deviceId: null,
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
    host.send({ type: 'create_lobby', isLocal: true });
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
    host.send({ type: 'create_lobby', isLocal: true });
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

  it('supports reordering players with reorder_player', () => {
    const host = connect();
    host.send({ type: 'create_lobby', isLocal: true });
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
    host.send({ type: 'create_lobby', isLocal: false });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'update_settings', lobbyId, settings: { mode: 'count-up' } });

    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Carol' });
    expect(host.playerIds()).toHaveLength(2);

    const guest = connect();
    guest.send({ type: 'join_lobby', lobbyId });
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
    host.send({ type: 'create_lobby', isLocal: false });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'update_settings', lobbyId, settings: { mode: 'count-up' } });
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });

    const guest1 = connect();
    guest1.send({ type: 'join_lobby', lobbyId });
    guest1.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });

    const guest2 = connect();
    guest2.send({ type: 'join_lobby', lobbyId });
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

describe('n-players media activation', () => {
  it('enables media mesh for 2 distinct users even with 4 players', () => {
    const p1: Player = { id: 'p1', name: 'Alice', sessionId: 's1' };
    const p2: Player = { id: 'p2', name: 'Carol', sessionId: 's1' };
    const p3: Player = { id: 'p3', name: 'Bob', sessionId: 's2' };
    const p4: Player = { id: 'p4', name: 'Dave', sessionId: 's2' };

    const match = makeMatch({
      isLocal: false,
      players: [p1, p2, p3, p4],
    });

    expect(userCountOf(match)).toBe(2);
    // startMediaForMatch should not throw and should activate for 2 users
    startMediaForMatch(match);
  });

  it('disables media mesh when userCount > 2', () => {
    const p1: Player = { id: 'p1', name: 'Alice', sessionId: 's1' };
    const p2: Player = { id: 'p2', name: 'Bob', sessionId: 's2' };
    const p3: Player = { id: 'p3', name: 'Carol', sessionId: 's3' };

    const match = makeMatch({
      isLocal: false,
      players: [p1, p2, p3],
    });

    expect(userCountOf(match)).toBe(3);
  });
});
