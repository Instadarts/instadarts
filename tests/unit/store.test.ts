import { describe, it, expect, beforeEach } from 'vitest';
import '../helpers'; // installs the x01 game mode
// count-up declares no player cap of its own, which is the only way to see the deployment's.
import { countUp } from '../../src/server/modes/count-up';
import { registerMode } from '../../src/server/modes/types';

// A mode that caps itself at two players, because no shipped one does any more. Vitest isolates
// per file, so it goes no further — see docs/game-modes.md, "Limiting the player count".
registerMode({ ...countUp, id: 'two-only', label: 'Two Only', maxPlayers: 2 });
import { createLobby, getLobby, deleteLobby, createMatch, getMatch, addPlayerToLobby, removePlayerFromLobby, movePlayerInLobby, findLobbyByInviteCode, setLobbyInviteCode } from '../../src/server/store';

describe('Store', () => {
  beforeEach(() => {
    // Note: store is module-level, but each test creates unique IDs
  });

  describe('lobbies', () => {
    it('creates and retrieves an empty lobby', () => {
      const lobby = createLobby();
      expect(lobby.id).toBeTruthy();
      expect(lobby.players).toHaveLength(0);
      expect(lobby.settings.mode).toBe('x01');
      expect(lobby.settings.modeSettings.startScore).toBe(501);

      const found = getLobby(lobby.id);
      expect(found).toBeDefined();
    });

    it('adds player to lobby', () => {
      const lobby = createLobby();
      const updated = addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice' });
      expect(updated).not.toBeNull();
      expect(updated!.players).toHaveLength(1);
      expect(updated!.players[0].name).toBe('Alice');
    });

    it('adds second player to lobby', () => {
      const lobby = createLobby();
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice' });
      const updated = addPlayerToLobby(lobby.id, { id: 'p2', name: 'Bob' });
      expect(updated).not.toBeNull();
      expect(updated!.players).toHaveLength(2);
    });

    it('refuses a player past a cap the mode declares', () => {
      // The mode declares two, so the cap this lobby enforces is the mode's rather than the
      // deployment's five.
      const lobby = createLobby();
      lobby.settings = { ...lobby.settings, mode: 'two-only' };
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice' });
      addPlayerToLobby(lobby.id, { id: 'p2', name: 'Bob' });
      expect(lobby.players).toHaveLength(2);
      expect(addPlayerToLobby(lobby.id, { id: 'p3', name: 'Charlie' })).toBeNull();
    });

    it('takes the deployment cap where the mode declares none — x01 included', () => {
      // A new lobby is an x01 lobby, and x01 declares nothing, so a fresh one already takes five.
      const lobby = createLobby();
      expect(lobby.settings.mode).toBe('x01');
      for (let i = 1; i <= 5; i++) {
        expect(addPlayerToLobby(lobby.id, { id: `p${i}`, name: `P${i}` })).not.toBeNull();
      }
      expect(addPlayerToLobby(lobby.id, { id: 'p6', name: 'P6' })).toBeNull();

      const counted = createLobby();
      counted.settings = { ...counted.settings, mode: 'count-up' };
      for (let i = 1; i <= 5; i++) {
        expect(addPlayerToLobby(counted.id, { id: `c${i}`, name: `C${i}` })).not.toBeNull();
      }
      expect(addPlayerToLobby(counted.id, { id: 'c6', name: 'C6' })).toBeNull();
    });

    it('moves a player up and down the order, and no further than the ends', () => {
      const lobby = createLobby();
      lobby.settings = { ...lobby.settings, mode: 'count-up' };
      for (const [id, name] of [['p1', 'Alice'], ['p2', 'Bob'], ['p3', 'Carol']]) {
        addPlayerToLobby(lobby.id, { id, name });
      }
      const names = () => getLobby(lobby.id)!.players.map((p) => p.name);

      expect(movePlayerInLobby(lobby.id, 'p3', 'up')).not.toBeNull();
      expect(names()).toEqual(['Alice', 'Carol', 'Bob']);
      expect(movePlayerInLobby(lobby.id, 'p3', 'down')).not.toBeNull();
      expect(names()).toEqual(['Alice', 'Bob', 'Carol']);

      // At an end there is nowhere to go, and saying so is a no-op rather than an error.
      expect(movePlayerInLobby(lobby.id, 'p1', 'up')).toBeNull();
      expect(movePlayerInLobby(lobby.id, 'p3', 'down')).toBeNull();
      expect(movePlayerInLobby(lobby.id, 'nobody', 'up')).toBeNull();
      expect(names()).toEqual(['Alice', 'Bob', 'Carol']);
    });

    it('finds lobby by invite code', () => {
      const lobby = createLobby();
      setLobbyInviteCode(lobby.id, 'ABC123');
      const found = findLobbyByInviteCode('ABC123');
      expect(found).toBeDefined();
      expect(found!.id).toBe(lobby.id);
    });

    it('deletes a lobby', () => {
      const lobby = createLobby();
      deleteLobby(lobby.id);
      expect(getLobby(lobby.id)).toBeUndefined();
    });
  });

  describe('matches', () => {
    it('creates a match from a lobby', () => {
      const lobby = createLobby();
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice' });
      addPlayerToLobby(lobby.id, { id: 'p2', name: 'Bob' });
      const match = createMatch(lobby);

      expect(match.id).toBeTruthy();
      expect(match.status).toBe('in_progress');
      expect(match.players).toHaveLength(2);
      expect(match.settings.modeSettings.startScore).toBe(501);

      // Lobby should be deleted after match creation
      expect(getLobby(lobby.id)).toBeUndefined();
    });

    it('gets and updates a match', () => {
      const lobby = createLobby();
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice' });
      const match = createMatch(lobby);

      const found = getMatch(match.id);
      expect(found).toBeDefined();
    });
  });

  describe('what leaving does to the store', () => {
    // What a leave *means* is decided in wsHandler and covered there — rematch.test.ts,
    // nplayers.test.ts and one-user.test.ts. What is left for this file is the store operations
    // those handlers call.

    it('host leaving lobby: deleteLobby cleans up the lobby', () => {
      const lobby = createLobby();
      const lobbyId = lobby.id;
      // Host leaves → deleteLobby
      deleteLobby(lobbyId);
      expect(getLobby(lobbyId)).toBeUndefined();
    });

    it('non-host leaving lobby: player removed, lobby still exists', () => {
      const lobby = createLobby();
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice', sessionId: 'host' });
      addPlayerToLobby(lobby.id, { id: 'p2', name: 'Bob', sessionId: 'joiner' });

      const updated = removePlayerFromLobby(lobby.id, 'p2');
      expect(updated).not.toBeNull();
      expect(updated!.players.map((p) => p.name)).toEqual(['Alice']);
      // The lobby outlives a guest: only the host leaving abandons it.
      expect(getLobby(lobby.id)).toBeDefined();
    });
  });
});
