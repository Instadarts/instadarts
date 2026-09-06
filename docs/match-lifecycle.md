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
| Match finished | Show the result and collect re-match votes | The summary expires, including after a re-match starts |

Starting play consumes the lobby and creates a `MatchState` with status `in_progress`. A finished
match has status `finished`; `winnerId` is present for a win and absent for a cancellation.

Lobbies and matches share the `server.maxMatches` room budget. Starting an existing lobby has no
net room cost and is allowed even at that limit. New lobbies and re-matches need a free slot;
the latter retain the previous summary until its deadline.

## Connections and private identity

Every WebSocket connection receives a new random `sessionId`. It identifies that live connection,
not a persistent person or account. Server-side lobby and player records associate ownership with
the current session, but those session ids are removed from public room state.

Connection-specific messages provide the conclusions a client needs: `yourPlayerIds`,
`youAreHost`, and `youAreSpectator`. They are sent to one connection rather than broadcast to the
room.

Gameplay commands act on the connection's current room; they do not select a room by ID. Joining
uses an invite code, while spectating and reconnecting identify their destination explicitly.
`join_lobby` takes a seat without adding a player; `add_local_player` supplies each player's name.
Despite its name, `leave_match` leaves the current lobby or match, for participants and spectators.
Legacy extra room-ID fields on gameplay commands are ignored; they do not reject stale commands.

## Seats and authorization

A **seat** is a place in one lobby or match and the private token that proves control of it. It
contains the player ids held by the tab and whether the host role belongs to that seat. The server
grants one when a connection creates or joins a lobby or first adds a player.

Seats are the authority for gameplay permissions. `playersOf` and `holdsPlayer` read them directly;
client and player records do not maintain a second ownership list. A connection without the current
seat cannot throw, submit, start, vote, or leave on behalf of its former occupant.

Submitting a visit requires ownership of its player, including a zero-dart visit. Before a visit
exists, the current player owns that turn. A local seat holding several players may submit for
whichever of them is up; another participant cannot use an empty submit to skip their turn.

Seat tokens are sent only to their holder and stored in `sessionStorage`. Independently opened tabs
therefore receive separate seats. Duplicating a tab copies the token; presenting it transfers the
seat to the new connection and sends `seat_taken_over` to the previous holder.

Spectators receive no seat. Explicitly leaving a match revokes the seat and is final.

An open lobby's invite code is a separate admission credential. Only current seated participants
receive it, including participants who have not added players. Spectator snapshots and broadcasts
carry `inviteCode: null`; knowing the public lobby id grants viewing access without revealing a
joining credential. Filtering happens per recipient, so participants still receive refreshed codes
when the last guest leaves and regain code access when they resume their seat.

The implementation is in [`seats.ts`](../src/server/seats.ts), with permission checks in
[`connections.ts`](../src/server/connections.ts) and
[`wsHandler.ts`](../src/server/wsHandler.ts).

## Reconnection and disconnect detection

After a socket replacement, the frontend sends `reconnect` with its room and seat token before
flushing messages queued during the outage. Redeeming the token restores the held players and host
role and binds the seat to the new session.

A closed frontend connection receives a three-second grace period before it is treated as a leave.
Redeeming its seat transfers ownership to the new session, so the old connection's deferred leave
does not affect it. The cleanup callback still runs at the original deadline to release the closed
connection and its session resources. Each closed socket has an independent timer, including lobby
occupants who have not added players. A spectator has no seat to redeem and instead re-enters the
room through `spectate` on the replacement connection.

Connections that disappear without a close frame are detected by
[`heartbeat.ts`](../src/server/heartbeat.ts). The server pings every 30 seconds and terminates a
connection that misses a round, sending it through the ordinary close and grace-period path.

WebSocket messages are limited to 16 KiB. An oversized message or malformed frame closes only
the offending connection; admitted clients follow the ordinary disconnect cleanup path. Transport
errors are handled even on sockets being refused for capacity, so they cannot terminate the server.

Numeric fields in gameplay and device reports require JSON numbers; settings toggles require JSON
booleans. Invalid settings fields retain their current values, invalid darts are refused, invalid
tip reports are dropped whole, and malformed device claims are skipped individually. An unexpected
synchronous message-handler exception closes that connection with code 1011 and a generic reason;
the normal disconnect path handles cleanup. This exception boundary does not roll back state that
a handler changed before failing.

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

When every participant accepts and room capacity is available, `createRematch` creates a new match with the same
participants and settings and rotates the player order by one. Scores, visits, completed legs, and
media state do not carry over. Participant seat tokens carry into the new match, and connected
spectators move to it.

The previous match and its seats remain stored until that match's original summary deadline.
`carrySeats` copies the seats into the new match without removing the old entries. The retained
summary still counts toward the shared lobby/match capacity, so a re-match requires an additional
room slot. Expiring the old summary removes only that room and its seats; clients already on the
re-match stay there.

## Deadlines and reclamation

[`lifecycle.ts`](../src/server/lifecycle.ts) owns every room deadline:

| State | Deadline | Result |
| --- | --- | --- |
| Lobby | 10 minutes idle | Abandoned and deleted; connected clients return home |
| Match in progress | 10 minutes idle | Cancelled and moved to its summary |
| Match finished | 2 minutes | Neutral votes decline, clients still on that summary return home, and the match is deleted |

Participant input resets an idle deadline. Spectating and reconnecting do not, and the
finished-match deadline is fixed. Room-ending handlers remove room, seat, scoring and media state.
[`retention.test.ts`](../tests/unit/retention.test.ts) checks the lobby, match and scoring stores
after the tested expiry sequences; its cleanup explicitly removes mock clients. It does not verify
production connection reclamation.

Connections have a separate lifetime: an idle browser that answers heartbeat pings may stay
connected after its room expires. Closed connections awaiting their three-second cleanup deadline
still count toward admission. `/server-stats.connectedClients` reports the WebSocket server's socket
set, so it can be lower than the application client registry count during that grace period.
[`disconnect.test.ts`](../tests/unit/disconnect.test.ts) checks deferred connection reclamation and
seat ownership through handler-level reload, takeover and unresumed-departure sequences.
