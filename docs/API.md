# Match integration API

External software can create a match with fixed settings and an ordered roster, distribute a
personal invitation to each player, and watch the match through the existing spectator WebSocket.
Players cannot change the roster, names, order, mode, or settings, and cannot request a rematch.
Play starts automatically when every listed player has joined on a connected frontend.

HTTP and WebSocket routes use the same server and enabled listeners as the browser application.
No accounts, database, SDK, or separate subscription service are required.

## Configure callers

Add integration credentials to the deployment's settings file and restart the server:

```json
{
  "server": {
    "apiKeys": [
      { "id": "league-manager", "key": "REPLACE_WITH_A_RANDOM_SECRET" },
      { "id": "club-manager", "key": "REPLACE_WITH_ANOTHER_RANDOM_SECRET" }
    ]
  }
}
```

The default is `apiKeys: []`, which disables the HTTP API. Caller IDs must be nonempty and unique,
with no leading or trailing whitespace. IDs are preserved exactly, rather than silently trimmed.
Keys must be unique printable ASCII strings without spaces, **at least 16 characters long**.
This minimum does not measure strength or reject placeholders: the example keys above pass length
validation and must still be replaced. Invalid key configuration stops startup without echoing the
offending credential. Generate a long random key, for example:

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("base64url"))'
```

Send `Authorization: Bearer <key>` on each HTTP API request. Each key accesses only the matches
created under its caller ID; another caller's match is indistinguishable from an unknown ID.
Use HTTPS when sending credentials over a network. Keep these keys in the external application's
backend; they are never sent in browser configuration or spectator messages. There is no key
management endpoint or browser CORS integration.

Live spectators are intentionally public to anyone with the room or match ID, just like the
browser's spectator links. HTTP caller isolation does not make live match information private.
Player invitation codes grant admission to specific players; the API key is never needed to join.

## Discover game modes and settings

`GET /api/v1/modes` returns `200` with `{ modes, matchFields, matchDefaults }`. It requires the same
bearer authentication as the match endpoints. Modes are ordered by ID and include only those
installed in this server build: production includes X01 and Whac-A-Mole; development also includes
the Count-Up example.

Each entry in `modes` contains:

| Field | Meaning |
| --- | --- |
| `id`, `label` | Mode ID for creation and its display name. |
| `fields` | Editable mode settings, with `key`, `label`, and `kind`: `toggle`, `number`, or `select`. |
| `defaults` | Defaults for **only** those editable fields; safe to submit as `settings.modeSettings`. Server-owned keys are omitted here, but accepted and ignored if you send them. |
| `maxPlayers` | Mode's own player cap, or null when the mode imposes none. |
| `effectiveMaxPlayers` | Deployment cap narrowed by the mode's cap; the maximum roster accepted by creation. |
| `bansMedia` | Media features declined by this mode, such as Whac-A-Mole's `boardVideo`. |

Number fields have inclusive integer `min`/`max` bounds and optional suggested `options` with
`value`/`label` pairs. Select fields require one of their listed string option values; toggles
require JSON booleans. `matchFields` describes the format fields `legsToWinSet` and
`setsToWinMatch` with the same schema; `matchDefaults` supplies their defaults, both currently 1.
These format settings go directly in `settings`, alongside `mode` and `modeSettings`.

For example, create using a discovered mode's editable defaults:

```js
const response = await fetch(`${base}/api/v1/modes`, { headers });
if (!response.ok) throw new Error(await response.text());
const catalog = await response.json();
const mode = catalog.modes.find((entry) => entry.id === 'whac-a-mole');
if (!mode) throw new Error('Whac-A-Mole is not installed');
const body = {
  settings: { mode: mode.id, modeSettings: mode.defaults, ...catalog.matchDefaults },
  players: [{ name: 'Alex' }],
};
// POST JSON.stringify(body) to /api/v1/matches using the same authenticated headers.
```

The HTTP catalog omits **server-owned** settings — those a mode has but does not offer for editing,
such as Whac-A-Mole's random `seed` and production X01's hidden `stats`. Creation chooses these
itself, once, and nothing afterwards replaces them: not catalog reads, joins, scoring, undo, new
legs/sets, reconnects, or result retrieval.

Sending a server-owned key anyway is **not** an error. Creation recognises it and keeps its own
value, so a settings object that came back from creation — or from the WebSocket `mode_catalog`,
which does include these defaults — can be handed straight back without filtering. What you cannot
do is choose the value: submitting `seed` does not pin the seed. Keys the mode does not have at all
are still rejected, and the error names the key.

## Create a match

`POST /api/v1/matches`, with `Content-Type: application/json` and a JSON body of at most 16 KiB:

```json
{
  "settings": {
    "mode": "x01",
    "modeSettings": {
      "startScore": 501,
      "doubleIn": false,
      "doubleOut": true
    },
    "legsToWinSet": 3,
    "setsToWinMatch": 1
  },
  "players": [
    { "name": "Alex" },
    { "name": "Alex" }
  ]
}
```

`settings.mode` must identify an installed mode. Use `GET /api/v1/modes` to discover installed
modes, editable fields, defaults, and limits. See also
[game modes](./game-modes.md). Omitted settings use that mode's defaults and a format of one leg
per set and one set per match. Invalid supplied values and unknown request, player, or settings
fields are rejected; numeric strings are not numbers and string booleans are not booleans.

Supply between one player and the effective deployment/mode player limit. Names are trimmed and
control characters removed, then must contain 1–20 JavaScript string characters. Duplicate names
are allowed. The returned roster has the submitted order and sanitized names. That order is the
playing order, with the existing leg/set starting-player rotation.

The `201` response contains:

```json
{
  "lobbyId": "2c9e9088-7220-4d30-9d45-524056feab5d",
  "matchId": "ecf805b5-2c53-4842-b0d2-339768c0dfee",
  "settings": {
    "mode": "x01",
    "modeSettings": { "startScore": 501, "doubleIn": false, "doubleOut": true, "stats": "graphic" },
    "legsToWinSet": 3,
    "setsToWinMatch": 1
  },
  "players": [
    { "id": "01ef291c-6476-4a29-9826-69e2a950a64c", "name": "Alex", "inviteCode": "ABCD23" },
    { "id": "44c044a7-8d94-46ba-aad8-32659f171f7e", "name": "Alex", "inviteCode": "EFGH45" }
  ]
}
```

The response includes all effective mode defaults, including the server-owned ones the installed
build does not expose for editing. It can be submitted again as-is: server-owned keys are accepted
and ignored, so the next match gets a fresh `seed` rather than this one's. Effective settings are
fixed at creation, including those generated defaults.

Each `players[].id` is a new UUID scoped to this match. Use IDs, not names, to correlate visits,
standings, departures, and winners. Match the response entries to the input entries by position.
There is no persistent player-account identity and no caller-supplied player ID.

Every successful POST creates a new match. There is no idempotency key, update, or automatic retry
deduplication, so a retried creation is a second match — [delete](#cancel-a-match) the one you did
not want. Save the response, including the personal codes; subsequent reads do not return codes.

### Invitations and shared boards

Distribute `<base-url>/lobby/join/<inviteCode>` to each player. Codes contain six uppercase
characters from the existing unambiguous alphabet, and are unique across live ordinary and
personal invitations. They do not authenticate a person's real identity: whoever holds an
available code can claim its player.

Joining claims the existing player immediately; there is no name-entry step. One browser may
claim additional players in the same lobby using **Add player by invite code**. They share its
seat, dartboard, camera/scoring devices, and reconnect token. Their board ID is the first of those
players in roster order, even if invitations were redeemed in a different order.

To assign a shared board directly, distribute a link containing each player's personal code:
`<base-url>/lobby/join/<inviteCodeA>/<inviteCodeB>`. More codes can be appended as path segments,
up to `server.maxPlayersPerMatch` codes in a link. For example, using the creation response:

```js
const sharedBoardPlayers = created.players.slice(0, 2);
const sharedBoardLink = `${base}/lobby/join/${sharedBoardPlayers.map((p) => p.inviteCode).join('/')}`;
```

All codes must be personal invitations from the same waiting API lobby. Opening the link claims
them together into one browser seat, adding to any players it already owns there. Every code is
validated before any claim is made: an unknown, expired, foreign-lobby, ordinary shared code, or
code claimed by another seat rejects the whole group and preserves existing ownership. Duplicate
codes are harmless and count toward the link's code limit. URL codes are case-insensitive.
If this group completes the roster, the browser goes directly to the automatically started match.
Reloads use the same saved seat token for every player on the board.

The browser sends one `join_lobby` message with `inviteCode` set to an array of personal codes:
`{ "type": "join_lobby", "inviteCode": ["ABCD23", "EFGH45"] }`. Direct WebSocket clients must use
the uppercase codes returned by creation. The existing string form still accepts a single ordinary
or personal code; the array form accepts only personal codes from one lobby.

Repeating a code already owned by the same browser is harmless. A code held by another seat is
refused, including during disconnect grace. An additional code for another lobby is refused
without disturbing the current seat; leave first to switch lobbies.

Before play, leaving releases all that seat's players back to waiting without deleting or renaming
them. Their codes remain reusable. A closed socket retains its seat for the existing three-second
reconnect grace, but does not count as connected for automatic start. The match starts exactly
once when every roster player is held by an open participant connection. Spectators do not count.

At start, all personal codes are retired. In-game reloads use the browser's saved seat token;
leaving, including disconnecting beyond three seconds, is final and applies the ordinary
[departure rules](./match-lifecycle.md#leaving-rooms). An old managed-lobby reconnect ID can resolve
to the carried match seat if the browser missed the automatic-start notification.

## Subscribe over WebSocket

Connect to `/ws` (`wss://` on HTTPS), then send:

```json
{ "type": "spectate", "id": "ecf805b5-2c53-4842-b0d2-339768c0dfee" }
```

Use the returned `matchId` immediately, even before any player joins. It resolves to the waiting
lobby and then to the running match. The browser spectator URL is `/spectate/<matchId>`.

A connection watches one room at a time; use one socket per match. Sending another `spectate`
changes the watched room. No seat token or API key is required for spectating. Server-to-server
clients may omit `Origin`; browser connections follow the deployment's WebSocket origin policy.

The socket first receives the existing connection/configuration messages (`connected`,
`mode_catalog`, and `app_config`). Consumers can ignore unrelated message types and do not need to
send media declarations or establish camera connections.

| Message | Meaning |
| --- | --- |
| `lobby_state` | Initial waiting snapshot and lobby updates. `lobby.apiManaged` is true; `joinedPlayerIds` lists players on connected seats. The roster and settings are already final. |
| `match_started` | Automatic start; the spectator follows the lobby into the reserved match ID. |
| `match_state` | Initial match snapshot on subscription, scoring updates, and some terminal outcomes. |
| `match_finished` | Terminal outcomes such as departures or idle cancellation. |
| `lobby_abandoned` | The waiting lobby expired without starting. |
| `match_closed` | The browser room's two-minute summary expired. Retained HTTP results remain available. |
| `error` | Request failed; `message` explains why. Invalid destinations preserve the previously watched room. |

Every match-bearing message contains `match`, `view`, `standings`, and optionally `panel`, plus
existing role/media fields. `match` includes roster, settings, current-leg `visits`, completed
`legs` (each with winner and visits), and optional `currentVisit` with unsubmitted darts.
`view.playerScores` provides mode-specific display values keyed by player UUID. Values are either
strings or `{ text, tone }` objects; they are not a universal numeric score.

`standings` contains `setWins`, current-set `legWins`, `setsPlayed`, `legsInCurrentSet`, and a `sets`
array with each set's leg wins and winner. Count maps use player UUIDs and omit zero entries.
Current-set leg counts reset when a set closes. A departure win does not invent scored leg/set wins.

**Check `match.status === "finished"` on every match-bearing message.** A scored finish arrives
as `match_state`, so waiting exclusively for `match_finished` misses it. `match.winnerId` is the
winning player UUID, or null for a cancellation. Treat the first terminal snapshot as the result;
later browser-summary departures may change the live room's `departed` list, but not its archived
result. `lobby_abandoned` is the terminal signal for a match that never started.

### Reconnection and limits

Answer the server's WebSocket ping frames with pong frames. Browsers and the Node `ws` package do
this automatically. The server checks heartbeat every 30 seconds. On transport loss, reconnect
with backoff and send `spectate` again. This returns the current full snapshot; there is no event
replay or sequence cursor. A consumer can replace its prior snapshot rather than reconstructing
missed darts from events.

If the room has already closed, use the authenticated HTTP read once to recover its result.
Spectating and HTTP reads do not extend any room or retention deadline.

Existing WebSocket limits apply: 16 KiB inbound messages and a 4 MiB per-connection outbound
threshold, including queued data. Large full-history snapshots or a slow consumer can exceed the
outbound threshold and cause disconnection. Full HTTP history remains available; the archive does
not extend browser viewing or WebSocket access after room closure.

## Retrieve state or a retained result

Use `GET /api/v1/matches/<matchId>` with the creating caller's bearer key. This is an on-demand
snapshot/recovery endpoint; regular polling is unnecessary. Add `?includeHistory=true` for scoring
history. Omitted `includeHistory` or `false` returns only the summary.

| Field | Meaning |
| --- | --- |
| `matchId`, `lobbyId` | Stable IDs returned by creation. |
| `status` | `waiting`, `in_progress`, `finished` (winner), `cancelled` (no winner), or `expired` (lobby never started). |
| `settings`, `players` | Effective settings and ordered public roster (`id`, `name`, `boardId`). No sessions, invitation codes, or seat tokens. |
| `joinedPlayerIds` | Connected roster IDs while waiting; empty after play starts. |
| `standings` | The same derived structure sent on the WebSocket. |
| `playerScores` | The mode's display scores keyed by UUID; empty before play. |
| `winnerId`, `departed` | Winner UUID or null, and departed player UUIDs. Archived values are frozen at termination. |
| `createdAt`, `startedAt`, `finishedAt` | Unix milliseconds; nullable start/finish times when those transitions have not happened. Lobby expiry also sets `finishedAt`. |
| `roomExpiresAt` | Current room deadline, or its recorded deadline at termination. |
| `resultExpiresAt` | Null before termination; the archive deletion deadline afterwards. |
| `history` | Included only when requested: completed `legs`, current-leg `visits`, and optional `currentVisit`. Empty leg/visit arrays for waiting or expired lobbies. |

History uses the existing scoring types. Each completed leg contains `winnerId` and `visits`; a
visit contains `playerId`, `visitNumber`, `voided`, and `darts`. Each dart includes coordinates and
its computed score (`label`, `points`, `mult`, `base`), and accepted darts have server-assigned IDs.
The current visit is unsubmitted and may still change through scoring or undo.

### List the caller's matches

`GET /api/v1/matches` returns `200` with `{ "matches": [...] }`, containing only API-created
matches owned by the authenticated caller, in creation order (oldest first). Ordinary browser
matches and other callers' matches are excluded. An empty inventory returns `{ "matches": [] }`.
There are no pagination or filter parameters in v1; the inventory is bounded by `server.maxMatches`.

Each entry contains `matchId`, `lobbyId`, `status`, `createdAt`, `startedAt`, `finishedAt`, and
`resultExpiresAt`. Timestamps use Unix milliseconds and the same nullability as individual match
responses. Both endpoints use the same detailed statuses:

| Status | Meaning |
| --- | --- |
| `waiting` | Lobby waiting for all players to join. |
| `in_progress` | Match is running. |
| `finished` | Match ended with a winner, including departure wins. |
| `cancelled` | Match ended without a winner. |
| `expired` | Lobby expired before play started. |

The list includes terminal records until deletion or their 24-hour retention deadline, even after
browser room cleanup. Server restarts also remove records. Listing returns no invitations,
credentials, roster, settings, scores, or history; use the creation response for invitations and
the individual endpoint for match details. Neither listing nor individual reads renew deadlines.
Use this inventory to discover matches for subscription or recovery; live updates still use `/ws`.

### Cancel a match

`DELETE /api/v1/matches/<matchId>` with the creating caller's bearer key ends a match at whatever
stage it has reached, and removes its record. What the people in the room are told is the ordinary
ending for that stage — the same one the idle deadline would have produced:

| Status when deleted | What the room is told | Room |
| --- | --- | --- |
| `waiting` | `lobby_abandoned`; every personal code is retired | Deleted immediately |
| `in_progress` | `match_finished` with no winner, exactly like an idle cancellation | Enters its ordinary two-minute summary, then closes |
| `finished`, `cancelled`, `expired` | nothing; the room is already gone or running out its summary | Left alone |

The `200` response body is the full match — the same fields as a read, **always including
`history`**, with `resultExpiresAt: null`. A room that was still live reports `status: "cancelled"`;
a match that had already finished keeps its recorded status and outcome.

**Do not rely on the DELETE response to preserve results.** Retrieve the match with
`GET /api/v1/matches/<matchId>?includeHistory=true` and save that response in the consumer before
deleting if its state is needed. Deletion removes the record before its response is delivered;
if the connection fails, that response cannot be recovered through HTTP. For an active match, a
pre-delete read is a snapshot: play can advance between GET and DELETE. If the completed result is
needed, wait for termination, retrieve and save it, then delete.

DELETE is idempotent in its effect: repeated requests leave the record absent. The first successful
request returns `200`; a second DELETE and every subsequent GET return `404`. Responses are not
replayed, so a retry cannot recover the first response's match data.

```js
// If this consumer needs the state, retrieve and persist it before deleting.
const stateResponse = await fetch(`${base}/api/v1/matches/${matchId}?includeHistory=true`, { headers });
if (!stateResponse.ok) throw new Error(await stateResponse.text());
const savedState = await stateResponse.json();
await saveMatchState(savedState); // Consumer-provided durable storage; do not delete if saving fails.

const deleteResponse = await fetch(`${base}/api/v1/matches/${matchId}`, { method: 'DELETE', headers });
if (!deleteResponse.ok) throw new Error(await deleteResponse.text());
// savedState remains available even if deletion's response is lost; no result is read from DELETE.
```

Deleting is the caller's own decision about its own match; it is not offered to players, and there
is no participant control that reaches it.

### Retention and capacity

Rooms retain their ordinary deadlines: ten minutes idle for a lobby or active match, three seconds
of disconnect grace, and two minutes for a finished browser summary. A match idle timeout cancels
play; the visit limit also cancels a leg that has not won by visit 500.

The first terminal result is copied into an immutable, sanitized in-memory archive, including full
scoring history. It covers scored wins, departure wins/cancellations, idle and visit-limit
cancellations, and waiting-lobby expiry. Unless explicitly deleted, records last **24 hours from
termination**, regardless of when the browser room closes. Reads do not renew that period. Restarting the server loses active
matches and archives; a later read then returns `404`.

API creation must fit both the existing shared lobby/match room budget and an independent
active-plus-retained API record budget, each bounded by `server.maxMatches`. Unexpired archived
records are never evicted to admit new matches. A full budget produces `503`; finishing a match
frees its room after summary cleanup but not its API record until retention expires. Full history
is retained, so memory depends on match length as well as record count. The existing player,
format, and visit limits continue to apply. `/server-stats` reports the API budget as
`capacity.maxApiRecords` / `apiRecords`, and the room budget as `capacity.maxRooms` /
(`openLobbies` + `heldMatches`). `heldMatches` includes finished summaries.

[Deleting a match](#cancel-a-match) frees its API record immediately at every stage. Room capacity
is released separately:

| State when deleted | API record slot | Room slot |
| --- | --- | --- |
| `waiting` | Freed immediately | Freed immediately with the lobby |
| `in_progress` | Freed immediately | Freed when the new two-minute summary is cleaned up |
| `finished`, `cancelled` | Freed immediately | Existing summary keeps its original deadline; already-closed rooms occupy no slot |
| `expired` | Freed immediately | Lobby is already gone |

Creation requires space in **both** budgets. Deleting a running match can therefore leave creation
returning `503` until summary cleanup. For example, with `maxMatches: 1`, deleting the only running
match reduces `apiRecords` to zero but leaves one held room for its two-minute summary. Deleting a
retained result whose room has already closed frees only an API slot; it cannot free a room occupied
by another match. Deadline-based room cleanup occurs on the next lifecycle sweep after the deadline.

Live API records have no age-based cutoff while their rooms remain active. If a room disappears
outside the normal lifecycle without an archived result, the next sweep drops its orphaned API
record and reserved-ID mapping to reclaim capacity; its missing result cannot be recovered.

### HTTP errors

Errors are JSON, for example:

```json
{ "error": { "code": "not_found", "message": "Match not found" } }
```

| Status | Codes / causes |
| --- | --- |
| `400` | `invalid_request` for invalid input, settings or query values; `invalid_json` for malformed JSON. Unknown request, player and settings fields are named, and so are unknown query parameters. |
| `401` | `unauthorized`: missing or invalid bearer key; includes `WWW-Authenticate: Bearer`. |
| `404` | `not_found`: API disabled, unknown endpoint, expired/unknown/deleted match, or another caller's match. |
| `405` | `method_not_allowed`: the path exists but not for this method; includes `Allow`. |
| `413` | `body_too_large`: creation body exceeds 16 KiB. |
| `415` | `unsupported_media_type`: creation requires `application/json`. |
| `503` | `capacity_exceeded`: room or API-record budget is full. DELETE frees an API slot immediately; match summary room slots remain until cleanup. |
| `500` | `internal_error`: unexpected failure, without internal details. |

Successful and error responses use `Cache-Control: no-store`. Unsupported `/api/` routes return
JSON errors instead of frontend HTML. HTTP error status is distinct from the match lifecycle
`status` field in successful response bodies.

## End-to-end example

This Node example uses the `ws` package. Configure its bearer key on the server first. It creates a
match, prints invitations, subscribes, and falls back to HTTP when the spectator room is gone.
Persist `created` in the consumer if recovery must survive the consumer's own restart.

```js
import WebSocket from 'ws';

const base = 'https://darts.example';
const apiKey = process.env.DARTS_API_KEY; // Consumer-side secret, not an InstaDarts config variable.
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
const response = await fetch(`${base}/api/v1/matches`, {
  method: 'POST', headers,
  body: JSON.stringify({
    settings: { mode: 'x01' },
    players: [{ name: 'Alex' }, { name: 'Alex' }],
  }),
});
if (!response.ok) throw new Error(await response.text());
const created = await response.json();
for (const player of created.players) {
  console.log(player.id, `${base}/lobby/join/${player.inviteCode}`);
}
console.log('Spectate:', `${base}/spectate/${created.matchId}`);

let done = false;
let retryMs = 1000;
async function recover() {
  const response = await fetch(`${base}/api/v1/matches/${created.matchId}?includeHistory=true`, { headers });
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  if (['finished', 'cancelled', 'expired'].includes(result.status)) {
    done = true;
    console.log('Retained result:', result);
  }
}
function subscribe() {
  if (done) return;
  const url = new URL('/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url); // ws automatically answers ping frames.
  socket.on('open', () => socket.send(JSON.stringify({ type: 'spectate', id: created.matchId })));
  socket.on('message', async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'lobby_state') {
      retryMs = 1000;
      console.log('Joined:', message.lobby.joinedPlayerIds);
    }
    if (message.match) {
      retryMs = 1000;
      console.log('Standings:', message.standings);
      if (message.match.status === 'finished') {
        done = true;
        console.log('Result:', message.match);
        socket.close();
      }
    }
    if (['lobby_abandoned', 'match_closed', 'error'].includes(message.type)) {
      try { await recover(); }
      catch (error) {
        done = true; // Surface missing/expired records or credential problems to the integration.
        console.error(error);
      }
      socket.close();
    }
  });
  socket.on('error', (error) => console.error('Socket:', error.message));
  socket.on('close', () => {
    if (done) return;
    setTimeout(subscribe, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  });
}
subscribe();
```
