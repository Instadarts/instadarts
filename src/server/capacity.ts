// How big this server is allowed to get.
//
// One number is set — `MAX_MATCHES`, from the environment — and everything below is derived from
// it. That is the point: the limits are a single coherent statement about the deployment rather
// than a handful of numbers that drifted apart. To run a bigger server, set that one variable.
//
// Each figure here is one of three kinds, and which one it is matters more than its value:
//
//   · **refused** — the server says no. Used where saying yes would cost memory it does not have.
//   · **evicted** — the oldest thing goes to make room. Used where refusing would punish the
//     wrong person: a user pairing a sixth camera should lose their first, not be told no.
//   · **backstop** — an eviction that should never fire. If it does, the model is wrong about the
//     deployment, not about the code.
//
// In practice the *user* limit is the one a real deployment meets first, because spectators consume
// a connection each and are deliberately not capped per match. The rest are worst cases: they bound
// what a broken or hostile client can do, not what an ordinary one will.

import { MAX_MATCHES, MEDIA_ENABLED } from './env';
import { getAllLobbies, getAllMatches } from './store';

export { MAX_MATCHES };

/**
 * Lobbies and matches share one budget, because they are one thing at two moments: `createMatch`
 * deletes the lobby it was given. Counting them separately let a server hold both in full.
 *
 * **Refused.**
 */
export const MAX_ROOMS = MAX_MATCHES;

/** An online match has two users; a local one has a single user holding both players. */
export const USERS_PER_MATCH = 2;

/**
 * Frontend connections. Spectators count: an audience is uncapped per match by design, so it is
 * this budget they spend from, and this is the limit a busy server actually reaches.
 *
 * **Refused**, as part of MAX_CONNECTIONS.
 */
export const MAX_USERS = USERS_PER_MATCH * MAX_MATCHES;

/**
 * Scoring devices one user may hold at once. A sixth pairing drops that user's oldest.
 *
 * This is the figure that bounds the claims registry, and the reason it can be bounded at all: a
 * per-session cap holds however many sessions there are, where a server-wide one only notices after
 * a single client has already filled it.
 *
 * **Evicted.**
 */
export const DEVICES_PER_USER = 5;

/** What a user is expected to actually have — two boards is already unusual, three is generous. */
export const TYPICAL_DEVICES_PER_USER = 3;

/**
 * Scoring-device connections. Sized on the typical figure rather than the per-user maximum, since
 * every user reaching their cap at once is not a deployment, it is an attack.
 *
 * **Refused** — the device is told the server is full and keeps its pairing.
 */
export const MAX_DEVICE_CONNECTIONS = TYPICAL_DEVICES_PER_USER * MAX_USERS;

/** Every socket, of either kind. **Refused** at the handshake. */
export const MAX_CONNECTIONS = MAX_USERS + MAX_DEVICE_CONNECTIONS;

/**
 * Remembered devices. The worst case rather than the typical one: every user holding their full
 * five, each for a device that is not currently connected.
 *
 * Note this only ever counts *live* resources. A record is dropped as soon as neither the phone is
 * connected nor any live session claims it, so the server holds nothing about devices belonging to
 * people who are not here.
 *
 * **Backstop.**
 */
export const MAX_DEVICE_RECORDS = DEVICES_PER_USER * MAX_USERS;

/**
 * Most peer links one media peer is ever offered at once.
 *
 * Not derived from MAX_MATCHES, because it is not about the server: it bounds what one phone is
 * asked to do. Two users with five cameras each would otherwise put eleven peers in a frontend's
 * roster, and every one of them is a decoder.
 *
 * **Refused** — the pair is simply not made. Which pairs survive is decided by the priority order in
 * media.ts, so what a peer loses is always the least valuable link rather than an arbitrary one.
 */
export const MEDIA_PEERS_PER_PEER = 6;

/**
 * Spectators admitted to media per room. An audience is uncapped per match by design, and every
 * extra viewer is another link on a player's phone — so this is the number that keeps a popular
 * match from taxing the people actually playing it.
 *
 * **Refused**, and spectators are last in the priority order besides.
 */
export const MEDIA_VIEWERS_PER_ROOM = 2;

// ============================================================
// The questions the server asks
// ============================================================

/** Both are the same question — a lobby and a match occupy the same seat. */
export function canCreateLobby(): boolean {
  return roomCount() < MAX_ROOMS;
}

export function canCreateMatch(): boolean {
  return roomCount() < MAX_ROOMS;
}

export function roomCount(): number {
  return getAllLobbies().size + getAllMatches().size;
}

/** Asked at the handshake, before a connection has said which kind it is. */
export function canAcceptConnection(current: number): boolean {
  return current < MAX_CONNECTIONS;
}

/** Asked when a connection turns out to be a scoring device, which is the first time we know. */
export function canAcceptDevice(current: number): boolean {
  return current < MAX_DEVICE_CONNECTIONS;
}

/** The derived model, for /server-stats — so an operator can see what the knob produced. */
export function capacityLimits() {
  return {
    maxMatches: MAX_MATCHES,
    maxRooms: MAX_ROOMS,
    maxUsers: MAX_USERS,
    maxConnections: MAX_CONNECTIONS,
    maxDeviceConnections: MAX_DEVICE_CONNECTIONS,
    devicesPerUser: DEVICES_PER_USER,
    maxDeviceRecords: MAX_DEVICE_RECORDS,
    mediaEnabled: MEDIA_ENABLED,
    mediaPeersPerPeer: MEDIA_PEERS_PER_PEER,
    mediaViewersPerRoom: MEDIA_VIEWERS_PER_ROOM,
  };
}
