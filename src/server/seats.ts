// The proof a returning tab presents to get its place back.
//
// `reconnect` is the one message that asserts an identity instead of exercising one, and it cannot
// be answered by asking who is asking: a page reload arrives on a new socket with a new session id,
// which is the whole reason the message exists. So the claim has to be carried by the tab, and a
// **seat** is what it carries — a random token minted when a connection first takes a place in a
// room, and told to nobody else.
//
// Two properties do all the work:
//
//   · **The seat says what may be resumed; the message does not.** A reconnect names a room and
//     presents a token, and everything else — which player, whether the host chair comes with it —
//     is read from the seat the server minted. There is nothing in the message left to lie about.
//   · **A token is never broadcast, and never travels on a match or a lobby.** Both of those go on
//     the wire whole, to everyone in the room, spectators included; a secret kept on the player
//     record would be published to exactly the people it exists to exclude. Keeping it here instead
//     means there is no message that could leak it by forgetting to strip it.
//
// Seats follow the room, not the phase: they are carried from a lobby into the match it starts and
// from a match into its re-match, because to the person holding one it is the same seat all evening.

import { randomBytes } from 'node:crypto';

export interface Seat {
  /** The player this seat comes back as, or null for a room held before any player was added. */
  playerId: string | null;
  /** Whether coming back also restores the host chair. */
  host: boolean;
}

interface HeldSeat extends Seat {
  /**
   * The connection currently holding this seat. Only ever used to find a seat again for the session
   * that owns it — granting a second one for the same session in the same room would leave the tab
   * holding a token for a place it no longer occupies.
   */
  sessionId: string;
}

/** Room id → token → seat. A room is a lobby id or a match id; they are drawn from one id space. */
const rooms = new Map<string, Map<string, HeldSeat>>();

function seatsIn(roomId: string): Map<string, HeldSeat> {
  let seats = rooms.get(roomId);
  if (!seats) {
    seats = new Map();
    rooms.set(roomId, seats);
  }
  return seats;
}

/**
 * Take a place in a room, replacing whatever place this session already had there.
 *
 * 256 bits from the system CSPRNG. Redeeming is a map lookup rather than a comparison, so there is
 * no secret-dependent compare here to run in constant time.
 */
export function grantSeat(roomId: string, sessionId: string, seat: Seat): string {
  const seats = seatsIn(roomId);
  for (const [token, held] of seats) {
    if (held.sessionId === sessionId) seats.delete(token);
  }
  const token = randomBytes(32).toString('hex');
  seats.set(token, { ...seat, sessionId });
  return token;
}

/**
 * The seat this session holds in this room, if it holds one.
 *
 * What it is for: a host creates a lobby before adding anybody, so the seat it is granted then has
 * no player yet. The player it adds afterwards belongs on the seat it already holds — not on a
 * second one, which would leave its tab holding a stale token.
 */
export function heldSeat(roomId: string, sessionId: string): { token: string; seat: Seat } | null {
  for (const [token, held] of rooms.get(roomId) ?? []) {
    if (held.sessionId === sessionId) return { token, seat: { playerId: held.playerId, host: held.host } };
  }
  return null;
}

/** Fill in a seat already held — the first player a connection adds to a room it is already in. */
export function updateSeat(roomId: string, token: string, patch: Partial<Seat>): void {
  const held = rooms.get(roomId)?.get(token);
  if (held) Object.assign(held, patch);
}

/**
 * Present a token. Returns the seat it stands for, or null — which is every failure there is: an
 * unknown room, an unknown token, a token from a room that has since closed.
 *
 * The seat is re-bound to the presenting connection, so the tab that has just come back is the one
 * that holds it from here on.
 */
export function redeemSeat(roomId: string, token: unknown, sessionId: string): Seat | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const held = rooms.get(roomId)?.get(token);
  if (!held) return null;
  held.sessionId = sessionId;
  return { playerId: held.playerId, host: held.host };
}

/** Give up a place for good. Leaving is final, and a seat is what "final" is enforced with. */
export function revokeSeat(roomId: string, sessionId: string): void {
  const seats = rooms.get(roomId);
  if (!seats) return;
  for (const [token, held] of seats) {
    if (held.sessionId === sessionId) seats.delete(token);
  }
}

/**
 * Carry every seat into the room that succeeds this one — a lobby into its match, a match into its
 * re-match. The tokens are unchanged, because the tab holding one has no way of hearing that the
 * room it names has been renamed.
 */
export function carrySeats(fromRoomId: string, toRoomId: string): void {
  const seats = rooms.get(fromRoomId);
  if (!seats || seats.size === 0) return;
  const next = seatsIn(toRoomId);
  for (const [token, held] of seats) next.set(token, { ...held });
}

/** The room is gone; so is every place in it. */
export function dropSeats(roomId: string): void {
  rooms.delete(roomId);
}

/** Tests only. */
export function resetSeats(): void {
  rooms.clear();
}
