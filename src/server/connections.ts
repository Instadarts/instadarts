// Who is connected, and how to talk to them.
//
// The registry and the four ways of addressing it — one socket, a lobby, a match, a session — with
// no opinion about what any message means. Both halves of the socket layer are built on this: the
// gameplay handlers in wsHandler.ts and the scoring-device handlers in scoringDevices.ts. It exists
// so that neither of those has to import the other merely to reach a socket.
//
// A connection is a frontend **or** a scoring device, never both; `Client.deviceId` is what tells
// them apart, and several functions here turn on it.

import type { WebSocket } from 'ws';
import type { ServerMessage } from '../shared/protocol';
import type { Lobby, MatchState, Player } from '../shared/types';
import type { Client } from './types';
import { formatMessage } from '../shared/protocol';
import { meshEligible, panelOf, viewOf } from './match';
import { heldSeat } from './seats';
import { maxPlayersFor } from './store';

const clients = new Map<WebSocket, Client>();

export function addClient(ws: WebSocket, client: Client): void {
  clients.set(ws, client);
}

export function getClient(ws: WebSocket): Client | undefined {
  return clients.get(ws);
}

export function dropClient(ws: WebSocket): void {
  clients.delete(ws);
}

/** Every connection, for the handful of sweeps that have to look at all of them. */
export function allClients(): IterableIterator<[WebSocket, Client]> {
  return clients.entries();
}

/** How many sockets are open, of either kind. The registry is the only thing that should count. */
export function clientCount(): number {
  return clients.size;
}

// ============================================================
// Who a connection may act for
// ============================================================

/**
 * The players this connection holds, read from the [seat](./seats.ts) that holds them.
 *
 * Asked of the seat and never remembered on the connection. A copy is a thing that can disagree, and
 * it did twice: `join_lobby` once cleared the connection's copy and not the seat's, orphaning
 * players onto a roster nobody owned, and the host's kick edited the remover's copy instead of the
 * owner's. Both were one invariant, maintained by hand, breaking. There is now nothing to maintain.
 *
 * A spectator holds no seat and therefore no players — the same answer by the same route, rather
 * than a case of its own.
 */
export function playersOf(client: Client): string[] {
  const roomId = client.matchId ?? client.lobbyId;
  if (!roomId || client.isSpectator) return [];
  return heldSeat(roomId, client.sessionId)?.seat.playerIds ?? [];
}

/**
 * Whether this connection may act for a player.
 *
 * The guards' form of the question. Separate from `playersOf` because it is asked on the path of
 * every dart, and wants an answer rather than a list to search.
 */
export function holdsPlayer(client: Client, playerId: string): boolean {
  return playersOf(client).includes(playerId);
}

// ============================================================
// Addressing
// ============================================================

export function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(formatMessage(msg));
  }
}

export function broadcastToLobby(lobbyId: string, msg: ServerMessage, excludeWs?: WebSocket): void {
  for (const [ws, client] of clients) {
    if (ws === excludeWs) continue;
    if (client.lobbyId === lobbyId || client.matchId === lobbyId) {
      send(ws, msg);
    }
  }
}

export function broadcastToMatch(matchId: string, msg: ServerMessage): void {
  for (const [ws, client] of clients) {
    if (client.matchId === matchId) {
      send(ws, msg);
    }
  }
}

/**
 * How many users are in a lobby — playing connections only, so neither a spectator watching it nor a
 * scoring device belonging to somebody in it is counted.
 *
 * Counted rather than stored: a number maintained across join, leave, disconnect and takeover is a
 * number that eventually disagrees with the registry it was meant to describe.
 */
export function usersInLobby(lobbyId: string): number {
  let count = 0;
  for (const [, client] of clients) {
    if (client.lobbyId === lobbyId && !client.isSpectator && !client.deviceId) count++;
  }
  return count;
}

/** The frontend connection for a session, if it is here. Never a scoring device. */
export function findSessionSocket(sessionId: string): WebSocket | null {
  for (const [ws, client] of clients) {
    if (!client.deviceId && client.sessionId === sessionId) return ws;
  }
  return null;
}

// ============================================================
// What a state message is made of
// ============================================================

/**
 * A match as it goes on the wire: the state, the mode's view of the current leg, and the mode's
 * panel. The three messages that carry a match all carry the same three things.
 *
 * Assembled here rather than at each of the places that send one, because a place that builds it by
 * hand can leave a part out — and one did. The re-match broadcast omitted the panel, so a re-match
 * started with no statistics block and only grew one when the first dart produced a message that
 * happened to include it. The client sets its panel from whatever arrives, so a message missing the
 * field does not leave the old one standing; it clears it.
 */
export function matchMessage<T extends 'match_state' | 'match_started' | 'match_finished'>(
  type: T,
  match: MatchState,
  you?: { playerIds?: string[]; spectator?: boolean },
) {
  return {
    type,
    match: { ...match, players: publicPlayers(match.players) },
    view: viewOf(match),
    panel: panelOf(match),
    yourPlayerIds: you?.playerIds,
    // Why there is no video, told to everyone rather than addressed: it is a fact about the match's
    // shape, not about the recipient. Silence would be indistinguishable from a mesh that failed.
    mediaDisabled: !meshEligible(match),
    // Addressed either way — `false` is as much an answer as `true`. Passing no `you` at all is
    // what makes a message a broadcast, and a broadcast settles nothing about anybody.
    youAreSpectator: you ? you.spectator ?? false : undefined,
  };
}

/**
 * A lobby as it goes on the wire.
 *
 * `you` is the part that differs per recipient: which players are theirs, and whether the lobby is
 * theirs. Both are parameters rather than fields of the lobby because a broadcast must not carry one
 * connection's standing to everyone else — which is exactly what `hostSessionId` used to do, and why
 * it is stripped here along with the players' own.
 *
 * Omitting `you` is what makes a message a broadcast: it then answers neither question, and a client
 * holding an answer already keeps it.
 */
/**
 * Why another user could not take a place in this lobby, or null if one could.
 *
 * One statement of the join rule, asked by the two things that need it: `handleJoinLobby`, which
 * refuses with the reason, and `lobbyMessage`, which sends the yes-or-no on so the lobby screen
 * stops offering a code exactly when the server would start refusing it. Written out on both sides
 * instead, the screen and the server drifted apart the moment either changed.
 */
export function joinRefusal(lobby: Lobby): string | null {
  // Asked first, because a lobby that admits nobody is not one you were nearly admitted to.
  if (!lobby.acceptsJoins) return 'This lobby is not open to joins';
  // A user brings at least one player, so the player cap caps them too: somebody who could never
  // take a place is refused rather than admitted to watch the Add button stay dead.
  const max = maxPlayersFor(lobby.settings.mode);
  if (lobby.players.length >= max || usersInLobby(lobby.id) >= max) return 'Lobby is full';
  return null;
}

export function lobbyMessage(
  lobby: Lobby,
  you?: { playerIds?: string[]; host: boolean; spectator?: boolean },
): ServerMessage {
  const maxPlayers = maxPlayersFor(lobby.settings.mode);
  const userCount = usersInLobby(lobby.id);
  const admitting = joinRefusal(lobby) === null;
  return {
    type: 'lobby_state',
    lobby: {
      ...lobby, maxPlayers, userCount, admitting,
      players: publicPlayers(lobby.players), hostSessionId: undefined,
    },
    yourPlayerIds: you?.playerIds,
    youAreHost: you?.host,
    youAreSpectator: you ? you.spectator ?? false : undefined,
  };
}

/**
 * Players with the private session id removed, and boardId computed.
 *
 * `boardId` is the id of the first player added by the same user, in roster order. Public, unlike
 * `sessionId`: it is an existing player id that the screen needs to map a thrower to a camera.
 */
export function publicPlayers(players: Player[]): Player[] {
  return players.map((player) => {
    // The first player of this player's user, in roster order. A player with no owner recorded is
    // its own board rather than joining player one's: guessing a shared camera is worse than
    // admitting there is none.
    const owner = player.sessionId
      ? players.find((p) => p.sessionId === player.sessionId)?.id
      : undefined;
    const { sessionId: _owner, ...rest } = player;
    return { ...rest, boardId: owner ?? player.id };
  });
}
