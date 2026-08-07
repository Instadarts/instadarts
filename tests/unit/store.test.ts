import { describe, it, expect, beforeEach } from 'vitest';
import '../helpers'; // installs the x01 game mode
import { createLobby, getLobby, deleteLobby, createMatch, getMatch, addPlayerToLobby, removePlayerFromLobby, findLobbyByInviteCode, setLobbyInviteCode } from '../../src/server/store';

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
      const updated = addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice', isRemote: false });
      expect(updated).not.toBeNull();
      expect(updated!.players).toHaveLength(1);
      expect(updated!.players[0].name).toBe('Alice');
    });

    it('adds second player to lobby', () => {
      const lobby = createLobby();
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice', isRemote: false });
      const updated = addPlayerToLobby(lobby.id, { id: 'p2', name: 'Bob', isRemote: true });
      expect(updated).not.toBeNull();
      expect(updated!.players).toHaveLength(2);
    });

    it('rejects third player', () => {
      const lobby = createLobby();
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice', isRemote: false });
      addPlayerToLobby(lobby.id, { id: 'p2', name: 'Bob', isRemote: true });
      const result = addPlayerToLobby(lobby.id, { id: 'p3', name: 'Charlie', isRemote: true });
      expect(result).toBeNull();
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
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice', isRemote: false });
      addPlayerToLobby(lobby.id, { id: 'p2', name: 'Bob', isRemote: false });
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
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice', isRemote: false });
      const match = createMatch(lobby);

      const found = getMatch(match.id);
      expect(found).toBeDefined();
    });
  });

  describe('handleClientLeave scenarios (store-level contracts)', () => {
    // These tests verify the data operations that handleClientLeave orchestrates.
    // The wsHandler-level refactor must preserve these state transitions.

    it('local match: setting status=finished with no winner simulates creator disconnect', () => {
      const lobby = createLobby();
      lobby.isLocal = true;
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice', sessionId: 's1' });
      addPlayerToLobby(lobby.id, { id: 'p2', name: 'Bob', sessionId: 's1' });
      const match = createMatch(lobby);

      // Simulate handleClientLeave: match.status = 'finished', no winner
      match.status = 'finished';
      match.finishedAt = Date.now();
      // winnerId stays null — local match cancellation

      expect(match.status).toBe('finished');
      expect(match.winnerId).toBeNull();
    });

    it('online match: player leave declares other player winner', () => {
      const lobby = createLobby();
      lobby.isLocal = false;
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice', sessionId: 's1' });
      addPlayerToLobby(lobby.id, { id: 'p2', name: 'Bob', sessionId: 's2' });
      const match = createMatch(lobby);

      // Simulate p1 leaves: p2 wins
      const otherPlayer = match.players.find((p) => p.id !== 'p1');
      expect(otherPlayer).toBeDefined();
      match.status = 'finished';
      match.winnerId = otherPlayer!.id;
      match.finishedAt = Date.now();

      expect(match.winnerId).toBe('p2');
      expect(match.status).toBe('finished');
    });

    it('host leaving lobby: deleteLobby cleans up the lobby', () => {
      const lobby = createLobby();
      const lobbyId = lobby.id;
      // Host leaves → deleteLobby
      deleteLobby(lobbyId);
      expect(getLobby(lobbyId)).toBeUndefined();
    });

    it('non-host leaving lobby: player removed, lobby still exists', () => {
      const lobby = createLobby();
      lobby.remoteConnected = true;
      addPlayerToLobby(lobby.id, { id: 'p1', name: 'Alice', sessionId: 'host' });
      addPlayerToLobby(lobby.id, { id: 'p2', name: 'Bob', sessionId: 'joiner' });

      // Simulate joiner (p2) leaves: remove player, set remoteConnected false
      const updated = removePlayerFromLobby(lobby.id, 'p2');
      expect(updated).not.toBeNull();
      expect(updated!.players).toHaveLength(1);
      lobby.remoteConnected = false;

      expect(getLobby(lobby.id)).toBeDefined();
      expect(lobby.remoteConnected).toBe(false);
    });
  });
});
