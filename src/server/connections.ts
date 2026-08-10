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
import { panelOf, viewOf } from './match';

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
  yourPlayerId?: string,
) {
  return {
    type,
    match: { ...match, players: publicPlayers(match.players) },
    view: viewOf(match),
    panel: panelOf(match),
    yourPlayerId,
  };
}

/**
 * A lobby as it goes on the wire.
 *
 * `you` is the part that differs per recipient: which player is theirs, and whether the lobby is
 * theirs. Both are parameters rather than fields of the lobby because a broadcast must not carry one
 * connection's standing to everyone else — which is exactly what `hostSessionId` used to do, and why
 * it is stripped here along with the players' own.
 *
 * Omitting `you` is what makes a message a broadcast: it then answers neither question, and a client
 * holding an answer already keeps it.
 */
export function lobbyMessage(lobby: Lobby, you?: { playerId?: string; host: boolean }): ServerMessage {
  return {
    type: 'lobby_state',
    lobby: { ...lobby, players: publicPlayers(lobby.players), hostSessionId: undefined },
    yourPlayerId: you?.playerId,
    youAreHost: you?.host,
  };
}

/**
 * Players with the one field that is nobody else's business taken off.
 *
 * `sessionId` says which user added a player, and a room's state is sent to the whole room —
 * opponents and spectators alike. Nothing outside the server reads it: whether a player is yours is
 * `yourPlayerId`, which goes to one connection rather than to everyone.
 */
function publicPlayers(players: Player[]): Player[] {
  return players.map(({ sessionId: _owner, ...player }) => player);
}
