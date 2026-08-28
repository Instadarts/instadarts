# Glossary — domain vocabulary

The shared names for concepts in code, documentation, and the interface. Definitions here describe
the current system; implementation details live in the documents linked from each section.

Terms marked **[x01]** or **[wam]** belong to that game mode. Do not use them in mode-agnostic
layers unless referring to that mode explicitly.

## People, rooms, and identity

### User

One frontend instance, normally one browser tab. InstaDarts has no accounts, logins, or persistent
user identity.

Each WebSocket connection receives a new `sessionId`. A returning tab resumes its place by
presenting a [seat](#seat), not by preserving that session id. Do not use **user** when you mean
[player](#player--participant): one user may hold several players.

### Player / Participant

A competitor in a match. Prefer **player** in code and interface text; **participant** is acceptable
in prose when contrasting players with users or spectators.

A player has an id, display name, and `boardId`. Server-side it also carries its owning user's
current session, but that ownership information is removed from public lobby and match state. The
receiving client instead gets its own `yourPlayerIds`. One player is enough for a practice match.

### Player limit

The maximum number of players a match may contain. The deployment sets the overall
`maxPlayersPerMatch`; a game mode may declare a lower `maxPlayers`. The effective limit is the lower
of the two. No current mode declares its own limit. See
[Limiting the player count](./game-modes.md#limiting-the-player-count).

### Board

The physical dartboard a user throws at. Every player held by the same user shares its `boardId`,
which is the id of the first player that user added.

Media source slots are assigned per board rather than per player. The current media topology
supports at most two boards; see [Ownership and lifetime](./media.md#ownership-and-lifetime).

### Lobby

The setup room where players, match format, and game-mode settings are chosen. It is a `Lobby`, not
a status of `MatchState`. Starting play consumes the lobby and creates a match with a fixed player
roster and settings.

The creating user is the [host](#host--creator). A lobby may accept joins, and spectators may watch
whether or not it does.

### Accepting joins

`Lobby.acceptsJoins` determines whether a lobby receives an invite code and admits new users. The
home screen calls a lobby without joins a **Local Match** and one with joins an **Online Match**.
The choice is fixed when the lobby is created and does not become a match setting.

Joining requires an invite code. Spectating remains available either way. Once play starts, match
behavior follows the users and players actually present; the match has no separate local/online
flag.

### Host / Creator

The user session that created the lobby. Server code calls it the **host**; interface text calls it
the **creator**. The host may change settings, reorder players, remove any player, and start the
match. It is a user role, not a player role.

The host session id remains private. The client receives `youAreHost` rather than deriving the role
from public state.

### Spectator

A read-only user watching a lobby or match through `/spectate/:id`. Spectators cannot perform
gameplay actions, control scoring, or vote on a re-match, and they receive no [seat](#seat).

A user who reaches match start without a player becomes a spectator. Leaving only stops watching;
it does not have the final gameplay meaning that a participant leaving has.

### Seat

The server-side place that authorizes a tab to act in one lobby or match. Its private token lets a
replacement WebSocket resume the room, held players, and host role. Presenting a token transfers
that seat from any previous connection.

Seats, not client or player records, are the authority for player ownership. Spectators have no
seat, and leaving a match revokes it. See
[Seats and authorization](./match-lifecycle.md#seats-and-authorization) for the connection ordering
and ownership rules.

### Match

The contest created when a lobby starts. A match contains a fixed roster, settings, current leg,
completed legs, re-match votes, and either an `in_progress` or `finished` status.

A game mode decides who won a leg; the match layer advances legs and sets and decides the match
winner. A finished match without `winnerId` was cancelled rather than won. Finished matches remain
available for their summary and re-match offer until their deadline.

Use **match**, not **game**, for this concept. In this codebase **game** appears only as part of
**game mode**.

### Departed

`MatchState.departed` records players whose user permanently left a running match. They remain in
the displayed roster and retain their results, but receive no further visits and cannot reconnect.
Leaving also counts as declining a re-match.

A user leaves with every player held by its seat. If one active player remains, that player wins;
if none remain, the match is cancelled.

### Re-match

A new match with the same participants and settings, created from a finished match without another
lobby. Scores and history do not carry over, and the player order rotates by one place.

Each participant accepts or declines. Any decline—including leaving—settles the vote as no
re-match; neutral votes become declines at the finished-match deadline. When everyone accepts, the
new match begins immediately and spectators move to it as well.

### Deadline

The `expiresAt` time after which a lobby or match advances to its terminal state. Lobby and active
match idle deadlines are 10 minutes; a finished match remains for 2 minutes. Participant input
resets idle deadlines, while spectating and reconnecting do not. See
[Deadlines and reclamation](./match-lifecycle.md#deadlines-and-reclamation).

### Invite code

A six-character code from an unambiguous alphabet, and the only credential for joining a lobby.
Only a lobby that [accepts joins](#accepting-joins) has one. When the last guest leaves, the lobby
receives a new code.

This is separate from a scoring-device **pairing code**, despite using the same length and alphabet.

## Match format and play

The match structure is mode-agnostic: a match contains sets, a set contains legs, and a leg is one
play-through of a game mode. See
[Match format around the mode](./game-modes.md#match-format-around-the-mode).

### Leg

One play-through of a [game mode](#game-mode), ending when the mode reports a winner. The current
leg's visits are in `MatchState.visits`; completed legs are stored as `CompletedLeg` entries in
`MatchState.legs`.

### Set

A group of legs won by the first player to reach `legsToWinSet`. The match is won by the first
player to reach `setsToWinMatch`. Both settings default to one.

### Standings

The sets won and the legs won in the current set. Standings are derived from the ordered completed
leg winners by [`matchFormat.ts`](../src/shared/matchFormat.ts), not stored separately.

The starting player advances one roster position per completed leg, continuing across set
boundaries. During a leg, departed players are skipped.

### Visit

One player's turn at the board. Prefer **visit** in code and documentation; **turn** is acceptable
only in general prose or where a mode defines it as its own term.

- `CurrentVisit` is the visit in progress: player, darts, and `locked` state.
- `Visit` is a submitted visit: player, darts, `visitNumber`, and `voided` state.

`visitNumber` counts all visits in the current leg, not visits per player. The game mode determines
the allowed dart count and finalizes the submitted visit.

### Locked visit

A `CurrentVisit` for which the mode accepts no further dart. Locked does not mean submitted: the
visit remains open for correction until the player submits it or the scoring pipeline detects
[takeout](./vision.md#server-fusion-and-visit-tracking). See the
[game-mode contract](./game-modes.md#the-contract).

### Voided visit

A submitted visit that scores nothing, represented by `Visit.voided`. The mode decides when this
applies. x01 calls its version a [bust](#x01-bust).

### Dart / Throw

`DartThrow` represents one dart as board coordinates plus a `ScoreResult`. Use **dart** for the
object; **throw** may describe the act. The server recomputes the score from the coordinates rather
than trusting a client-supplied value.

### Board coordinates

The integer space `[0, 1_000_000]²` with centre `(500000, 500000)` and the y-axis pointing upward.
The manual board and scoring devices both publish this coordinate system. It is defined in
[`scoring.ts`](../src/shared/scoring.ts).

### Score / ScoreResult

The dartboard result `{ label, points, mult, base }`. Labels include `S20`, `D20`, `T20`, `SB`,
`DB`, and `miss`.

A score describes where a dart landed and what that segment is worth. It is not a game-mode result;
the mode decides what to do with it.

### Game mode

The rules and settings for playing and winning one leg. Production registers x01 and Whac-A-Mole;
development and tests also register count-up.

A mode is pure server-side logic over `LegContext`. It determines visit capacity, locking, visit
finalization, the leg winner, and mode-specific presentation. It cannot advance the match, manage
connections, or write match state. See [Game modes](./game-modes.md).

### Mode view

`ModeView` is the mode's presentation for the current leg: headline, notices, player scores, visit
total, dart-slot content, history, dart count, and optional automatic submission. It is computed on
the server and sent as data so the match screen contains no mode rules.

Mode text may carry a semantic tone such as `danger` or `positive`, but not layout or typography.
See [The match screen](./game-modes.md#the-match-screen).

### Mode panel

`ModePanel` is the mode's optional block on the live match screen. It may derive match-wide display
statistics because its output is presentation only. A mode can use the generic table or provide an
optional client component for custom rendering. See
[The optional second file](./game-modes.md#the-optional-second-file).

## x01 vocabulary

These terms belong to x01 and must not be used as generic match or visit concepts.

### [x01] Start score

The value each player counts down from, stored as `modeSettings.startScore`. It defaults to 501 and
accepts values from 101 to 999.

### [x01] Remaining score

What a player still needs to score. It is derived by replaying that player's non-voided visits in
the current leg and is never stored as match state.

### [x01] Double in / Double out

- **Double in:** scoring begins with the first double; earlier darts score nothing.
- **Double out:** the winning dart must be a double or the bull.
- **Straight out:** double-out is disabled.

### [x01] Bust

x01's [voided visit](#voided-visit). A visit busts when it would go below zero, would leave one under
double-out, or reaches zero without the required double. It scores nothing and locks immediately.

Use **voided visit** in mode-agnostic code.

### [x01] Checkout

Reaching exactly zero, using a double or bull when double-out is enabled. A checkout wins the leg;
the match layer decides whether that also wins a set or match.

## Whac-A-Mole vocabulary

These terms belong to the co-operative Whac-A-Mole training mode.

### [wam] Area

One targetable board region. The mode distinguishes inner and outer singles but combines both bulls
as `BULL`, producing 81 areas.

### [wam] Mole, dig time, and hole

A **mole** occupies an area and scores one point when whacked. Its **dig time** is the number of
turns available to hit it. If it finishes digging, the area becomes a permanent **hole** and darts
landing there reduce their owner's future dart allowance.

Dig time is fixed when the mole appears.

### [wam] Burrow

The combined bull area. It begins as a hole, never contains a normal mole, and stores darts lost to
holes in the order they were lost.

### [wam] Janitor

A special mole that can appear at the burrow while it holds a lost dart. Hitting it returns the
oldest dart to its owner, who may be another player. The janitor can be hit once per visit and
awards a dart rather than an extra point.

### [wam] Run, turn, and curtain call

A **run** is one leg. A **turn** is the mode's name for one visit. The configured turn count is
rounded up so every player receives the same number of turns.

A run ends when its turns are complete, no player has a dart available, or every targetable area is
a hole. The following locked, dartless visit is the **curtain call**; submitting it ends the leg
after showing the closing presentation.

### [wam] Perfect run / Points per turn

A **perfect run** earns every available mole and sweep point. Its maximum is
`actual turns × (min(darts, moles) + 1)`. **Points per turn** (`ppt`) is the team score divided by
the turns taken.

### [wam] Seed

The deterministic starting value used to generate a run's mole areas, reactions, and text. Dart
coordinates feed subsequent generation, so equal seeds diverge when the throws differ. A re-match
copies the seed with the other mode settings.

### [wam] Enraged / Frenzy

Difficulty stages based on run progress. At three-fifths, newly spawned moles are **enraged** and
lose one turn of dig time; at four-fifths, **frenzy** removes another.

## Scoring devices

### Scorer / Scoring device

A paired device running `/scorer`. It observes the dartboard through a camera and reports dart-tip
coordinates to the server. **Scorer** and **scoring device** are interchangeable; wire messages use
`scorer_`, while most server identifiers use `device`.

The scorer is a sibling application with its own WebSocket and storage. It receives a projected
`scorer_state`, not lobby or match state, and it reports actual camera state separately from camera
commands requested by the frontend.

### Pairing, claiming, and camera state

These are separate states:

| State | Meaning |
| --- | --- |
| **Paired** | The device and frontend share credentials established with a pairing code |
| **Online** | The device currently has a WebSocket connection |
| **Active / claimed / grabbed** | Exactly one frontend session currently controls the paired device |
| **Camera active** | The device reports that its camera is running |
| **Scoring** | A running match would currently accept this device's tips |

Pairing creates `{ deviceId, token }` on the scorer and `{ deviceId, tokenHash }` on the frontend.
Both sides re-present those credentials after a server restart. The pairing is stored in
`localStorage`; the active claim is per tab in `sessionStorage`.

**Grab** is the client-side name and **claim** the server-side name for the same active state. A
camera also needs a media tier and board-camera nomination before another user can view it; see
[Match-scoped media](./media.md).

### Camera off, standby, and power off

**Camera off** stops the camera and motion detector after the short idle delay. **Standby** releases
the wake lock and closes the socket after the longer delay; only interaction on the device can
return from it. **Power off** is the frontend command that sends the device directly to standby.

The device owns these stages. See
[Power management](./vision.md#power-management).

### Scoring context, started, and resumed

A **scoring context** identifies the match and board a device currently feeds. Its opaque
`scoringContextId` remains stable across socket reconnections but changes for a new match, re-match,
or board.

**Started** means the device entered a different context; **resumed** means the same context arrived
on a replacement socket. Only a started context automatically wakes a camera that its owner turned
off. See the reconnect rules in
[vision.md](./vision.md#power-management).

### Pairing state / Device state

Pairing state is the device identity and shared credential. Device state describes the hardware:
name, camera selection, per-lens calibration and zoom, power delays, and media tier. Unpairing
removes the relationship but preserves the hardware settings and presentation zoom on the phone.

### Tip, throw window, tracked dart, takeout, and scoring session

- **Tip:** one device observation of a dart tip in board coordinates.
- **Throw window:** the interval in which observations of the same throw are fused.
- **Tracked dart:** a dart the server believes remains in the board.
- **Takeout:** an empty observation from every active camera, meaning the darts were removed.
- **Scoring session:** the per-match, per-board object that owns fusion and tracking state.

See [Server fusion and visit tracking](./vision.md#server-fusion-and-visit-tracking) for their
behavior and visit-submission rules.

## Media vocabulary

**Media** is the optional peer-to-peer feature carrying live board video and requested stills
between devices in a running match. The match server coordinates it but never receives image data.
The complete design is in [media.md](./media.md).

| Term | Meaning |
| --- | --- |
| **Media ban** | A game mode declining `boardVideo`, `dartEvidence`, or both; it does not disable the mesh |
| **Peer / peer id** | One live frontend or scoring-device socket in one match media session, identified by an opaque id |
| **Media tier** | What a scoring device offers: `disabled`, `stills`, or `video` |
| **Board camera** | The one claimed scoring device a user nominates to publish their board; none is valid |
| **Publisher / viewer** | The sending and receiving ends of a link; a scorer only publishes and a spectator only views |
| **Roster** | The server's authoritative list of peers a peer may connect to; absence from it closes and deauthorizes a link |
| **Media session** | The server-side coordinator for one running match, identified by a fresh `meshId` |
| **Link** | One `RTCPeerConnection` carrying reliable control and unreliable encoded-media data channels |
| **Mesh** | All links held by one client, sharing one encoder |
| **Region of interest** | A square in normalized board space, expressed by centre and side length |
| **Still** | A square JPEG of a requested region, sent over the control channel |
| **Dart evidence** | The still associated with a dart slot in the current visit |
| **Board video** | A live square view from the nominated board camera, shown in place of the virtual board when accepted and fresh |
| **Audience** | The allowed viewer roles: `owner`, `opponent`, and `spectator` |
| **Director command** | `video_region`: a requested region, transition time, and reset time for live video |
| **Virtual camera** | The crop and interpolation that applies director commands without moving a physical lens |

Important boundaries:

- the roster is the authorization for signaling and link lifetime;
- a link carries encoded data, not a WebRTC media track, so the mesh can encode once for all viewers;
- live-video offers require per-feed, per-recipient consent;
- audience parsing fails closed, and unavailable video leaves the virtual board usable.

See [Identities and topology](./media.md#identities-and-topology),
[Source coordination and feeds](./media.md#source-coordination-and-feeds), and
[Regions, stills, and dart evidence](./media.md#regions-stills-and-dart-evidence).

## Settings

| Kind | Owner | Scope | Detailed documentation |
| --- | --- | --- | --- |
| **Deployment settings** | Server operator | Whole deployment | [Development settings](./development.md#settings) |
| **Match settings** | Lobby host | One match | [Game-mode settings](./game-modes.md#settings) |
| **Device settings** | Person using the scoring device | One device | [The camera](./vision.md#the-camera) |
| **Presentation preferences** | Person using either application | Frontend or scorer | [UI persistence](./ui.md#match-layout-editing-and-persistence) |

### Deployment settings

Values in the optional `instadarts.config.jsonc`: server capacity, scorer tuning, and media
configuration. Defaults and schema live in [`config.ts`](../src/shared/config.ts). Browser-facing
values are delivered through [app config](#app-config).

### App config

The `app_config` message containing the browser-facing subset of deployment settings. It is sent to
frontends and scoring devices on connection and stored client-side by
[`appConfig.ts`](../src/client/lib/appConfig.ts).

### Match settings

`MatchSettings`: game mode, the mode's settings, and the legs/sets format. The host configures them
in the lobby; they are validated by the server and fixed when the match starts.

### Device settings

Hardware-specific values stored by the scorer, including its name, lens calibration, selected
camera and zoom, power delays, and media tier. They survive matches and unpairing.

### Presentation preferences

Local interface choices such as colour scheme, application zoom, and frontend match layouts. They
do not enter match state or deployment configuration. Frontend and scorer preferences are stored
independently.

## Naming conventions

- Use one term per concept in identifiers: **match**, **player**, **user**, **visit**, **dart**,
  **leg**, **set**, and **game mode**.
- Use x01 terms such as **bust**, **checkout**, and **remaining score** only inside x01. Generic
  layers use **voided visit**, **leg winner**, and **locked visit**.
- Use **game** only as part of **game mode**; use **match** for the contest.
- Say **scoring device** or **scorer**, not **camera**, when referring to the device itself.
- Say **media**, not **stream** or **call**, for the peer-to-peer feature.
- The server is authoritative for identity, scores, turn order, and match state; clients render and
  submit requests.
