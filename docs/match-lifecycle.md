# Match lifecycle and session ownership

Lobbies, matches, connections, and seats are in-memory server state. This document describes how
they relate, who may act on them, and how they end. Game rules and leg progression are covered in
[game-modes.md](./game-modes.md).

## Rooms and phases

A lobby and a match are separate server objects:

| State | Purpose | Ends when |
| --- | --- | --- |
| Lobby | Configure players, match format, and game mode | The host starts play, leaves, or the lobby expires |
| Match in progress | Play legs and sets with a fixed roster and settings | A winner is decided, the match is cancelled, or it expires |
| Match finished | Show the result and collect re-match votes | A re-match starts or the summary expires |

Starting play consumes the lobby and creates a `MatchState` with status `in_progress`. A finished
match has status `finished`; `winnerId` is present for a win and absent for a cancellation.

## Connections and private identity

Every WebSocket connection receives a new random `sessionId`. It identifies that live connection,
not a persistent person or account. Server-side lobby and player records associate ownership with
the current session, but those session ids are removed from public room state.

Connection-specific messages provide the conclusions a client needs: `yourPlayerIds`,
`youAreHost`, and `youAreSpectator`. They are sent to one connection rather than broadcast to the
room.

## Seats and authorization

A **seat** is a place in one lobby or match and the private token that proves control of it. It
contains the player ids held by the tab and whether the host role belongs to that seat. The server
grants one when a connection creates or joins a lobby or first adds a player.

Seats are the authority for gameplay permissions. `playersOf` and `holdsPlayer` read them directly;
client and player records do not maintain a second ownership list. A connection without the current
seat cannot throw, submit, start, vote, or leave on behalf of its former occupant.

Seat tokens are sent only to their holder and stored in `sessionStorage`. Independently opened tabs
therefore receive separate seats. Duplicating a tab copies the token; presenting it transfers the
seat to the new connection and sends `seat_taken_over` to the previous holder.

Spectators receive no seat. Explicitly leaving a match revokes the seat and is final.

The implementation is in [`seats.ts`](../src/server/seats.ts), with permission checks in
[`connections.ts`](../src/server/connections.ts) and
[`wsHandler.ts`](../src/server/wsHandler.ts).

## Reconnection and disconnect detection

After a socket replacement, the frontend sends `reconnect` with its room and seat token before
flushing messages queued during the outage. Redeeming the token restores the held players and host
role and binds the seat to the new session.

A closed frontend connection receives a three-second grace period before it is treated as a leave.
Redeeming its seat cancels that pending departure. A spectator has no seat to redeem and instead
re-enters the room through `spectate` on the replacement connection.

Connections that disappear without a close frame are detected by
[`heartbeat.ts`](../src/server/heartbeat.ts). The server pings every 30 seconds and terminates a
connection that misses a round, sending it through the ordinary close and grace-period path.

## Lobby ownership and admission

The user that creates a lobby is its host. The host may change settings, reorder players, remove
any player, and start the match. Other users may add and remove only the players held by their own
seat.

`Lobby.acceptsJoins` is fixed at creation. A lobby that accepts joins receives an invite code; a
lobby that does not has no code and cannot be joined. Spectating remains available in either case.
The server computes `userCount`, the effective player limit, and whether another user can be
admitted for each lobby response.

Before starting, the server reconciles the roster with the seats: players held by no seat are
removed, seat entries naming no player are pruned, and a connected user without a player becomes a
spectator. The roster and settings are fixed after the match is created. Participant seats carry
from the lobby into the match.

## Leaving rooms

Leaving a lobby revokes the user's seat and removes every player it held. If the host leaves, the
lobby is abandoned and everyone in it returns home. If the last guest leaves an open lobby, its
invite code is replaced before another guest can join.

A participant leaving—explicitly or after the disconnect grace period—adds every player held by
that seat to `MatchState.departed` and revokes the seat. Departed players remain visible with their
results but receive no further visits and cannot reconnect.

The match continues while at least two active players remain. If one remains, that player wins. If
none remain, the match is cancelled. Leaving also counts as declining a re-match.

A spectator leaving only stops watching and does not alter match state.

## Finished matches and re-matches

A finished match shows a summary while each participant's re-match vote is neutral, accepted, or
declined. Any decline settles the result as no re-match. Neutral votes become declines when the
summary expires.

When every participant accepts, `createRematch` creates a new match immediately with the same
participants and settings and rotates the player order by one. Scores, visits, completed legs, and
media state do not carry over. Participant seat tokens carry into the new match, and connected
spectators move to it.

## Deadlines and reclamation

[`lifecycle.ts`](../src/server/lifecycle.ts) owns every room deadline:

| State | Deadline | Result |
| --- | --- | --- |
| Lobby | 10 minutes idle | Abandoned and deleted; connected clients return home |
| Match in progress | 10 minutes idle | Cancelled and moved to its summary |
| Match finished | 2 minutes | Neutral votes decline, clients return home, and the match is deleted |

Participant input resets an idle deadline. Spectating and reconnecting do not, and the
finished-match deadline is fixed. Each ending path removes its own room and related scoring state;
[`retention.test.ts`](../tests/unit/retention.test.ts) verifies that the stores are empty afterwards.
