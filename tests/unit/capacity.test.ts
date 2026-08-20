import { describe, it, expect } from 'vitest';
import {
  DEVICES_PER_USER,
  MAX_CONNECTIONS,
  MAX_DEVICE_CONNECTIONS,
  MAX_DEVICE_RECORDS,
  MAX_MATCHES,
  MAX_ROOMS,
  MAX_USERS,
  MAX_USERS_PER_MATCH,
  canAcceptConnection,
  canAcceptDevice,
  canCreateLobby,
  canCreateMatch,
  roomCount,
} from '../../src/server/capacity';
import { CONFIG } from '../../src/server/config';
import { createLobby, createMatch, deleteLobby, deleteMatch, getAllLobbies, getAllMatches } from '../../src/server/store';
import '../helpers'; // registers the x01 mode

/**
 * The capacity model.
 *
 * One number is set and the rest are derived, so the thing worth testing is that they still relate
 * the way the file says they do — a limit that quietly stops scaling with the knob is not visible
 * anywhere else, and neither is a `NaN` from a bad setting, which would make every comparison
 * false and disable the limits it touches.
 */

describe('the derived model', () => {
  it('is whole numbers throughout', () => {
    for (const [name, value] of Object.entries({
      MAX_MATCHES, MAX_ROOMS, MAX_USERS_PER_MATCH, MAX_USERS,
      DEVICES_PER_USER, MAX_DEVICE_CONNECTIONS, MAX_CONNECTIONS, MAX_DEVICE_RECORDS,
    })) {
      expect(Number.isInteger(value), `${name} = ${value}`).toBe(true);
      expect(value, name).toBeGreaterThan(0);
    }
  });

  it('scales every limit from the one knob', () => {
    expect(MAX_ROOMS).toBe(MAX_MATCHES);
    expect(MAX_USERS).toBe(2 * MAX_MATCHES);
    expect(MAX_DEVICE_CONNECTIONS).toBe(3 * MAX_USERS);
    expect(MAX_CONNECTIONS).toBe(MAX_USERS + MAX_DEVICE_CONNECTIONS);
    expect(MAX_DEVICE_RECORDS).toBe(DEVICES_PER_USER * MAX_USERS);
  });

  it('leaves room for every user to hold their full allowance of devices', () => {
    // Records are the worst case and connections the typical one, so records must be the larger.
    expect(MAX_DEVICE_RECORDS).toBeGreaterThan(MAX_DEVICE_CONNECTIONS);
  });

  it('takes the knob from the settings', () => {
    // Where the number comes from, and what a bad one does, is config.test.ts's question. What
    // matters here is that this file reads that number rather than one of its own.
    expect(MAX_MATCHES).toBe(CONFIG.server.maxMatches);
    expect(MAX_USERS_PER_MATCH).toBe(CONFIG.server.maxPlayersPerMatch);
  });
});

describe('the room budget', () => {
  it('counts a lobby and a match against the same seat', () => {
    // The bug this replaced: two independent caps let a server hold a full complement of each.
    const before = roomCount();

    const lobby = createLobby();
    expect(roomCount()).toBe(before + 1);

    // Starting the match consumes the lobby rather than adding to it.
    const match = createMatch(lobby);
    expect(getAllLobbies().has(lobby.id)).toBe(false);
    expect(roomCount()).toBe(before + 1);

    deleteMatch(match.id);
    expect(roomCount()).toBe(before);
  });

  it('asks one question for both kinds of room', () => {
    expect(canCreateLobby()).toBe(canCreateMatch());
  });

  it('says yes on an empty server', () => {
    for (const id of [...getAllLobbies().keys()]) deleteLobby(id);
    for (const id of [...getAllMatches().keys()]) deleteMatch(id);
    expect(canCreateLobby()).toBe(true);
    expect(canCreateMatch()).toBe(true);
  });
});

describe('the connection budgets', () => {
  it('refuse only at the limit, not before it', () => {
    expect(canAcceptConnection(MAX_CONNECTIONS - 1)).toBe(true);
    expect(canAcceptConnection(MAX_CONNECTIONS)).toBe(false);

    expect(canAcceptDevice(MAX_DEVICE_CONNECTIONS - 1)).toBe(true);
    expect(canAcceptDevice(MAX_DEVICE_CONNECTIONS)).toBe(false);
  });

  it('leave every user room to connect even with devices at their cap', () => {
    // Devices must not be able to starve the people the server is for.
    expect(MAX_CONNECTIONS - MAX_DEVICE_CONNECTIONS).toBe(MAX_USERS);
  });
});
