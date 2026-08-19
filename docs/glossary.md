# Glossary — domain vocabulary

Shared vocabulary for everyone (and every agent) working on this codebase. The goal is that one
concept has exactly one name, in prose, in identifiers and in the UI.

**This document describes what exists today.** Where the code disagrees with the word we would like
to use, that is recorded as a mismatch rather than papered over — the implementation is the source
of truth.

### Markers

| Marker | Meaning |
| --- | --- |
| ⏳ | Agreed but **not implemented**. Never write about it as if it existed. |
| **[x01]** | Belongs to the **x01 game mode**, not to the app. Another mode need not have the concept at all. |

The **[x01]** distinction matters more than it looks. *Bust* and *checkout* are x01's names for
"this visit scored nothing" and "this dart won"; a mode where both players always throw the same
number of visits and nothing is ever overthrown has neither. Whenever you reach for a mode word,
check whether the layer you are writing in is allowed to know it — see
[Mode-specific vocabulary in mode-agnostic layers](#mode-specific-vocabulary-in-mode-agnostic-layers)
for the places where that has already gone wrong.

---

## At a glance

| Term | One-line meaning | How it appears in code today |
| --- | --- | --- |
| [User](#user) | One frontend instance. No accounts exist. | `sessionId`, `Client` |
| [Player](#player--participant) / Participant | A competitor in a match, added by a user | `Player`, `playerId`, `players[]` |
| [Seat](#seat) | A place in a room, and the token a reloaded tab presents to get it back | `seats.ts`, `resume`, `reconnect` |
| [Lobby](#lobby) | Setup phase of a match | `Lobby`, `lobbyId` |
| [Match](#match) | The whole contest between two players | `MatchState`, `matchId`, `match_*` messages, `/match/:id` |
| [Game Mode](#game-mode) | The rules of a single play-through (x01) | `GameMode`, `MatchSettings.mode`, `ModeDescriptor` |
| [Leg](#leg) | One play-through of the game mode | `MatchState.visits` (current), `CompletedLeg` |
| [Set](#set) | A group of legs, "first to n legs" | `legsToWinSet`, `setsToWinMatch`, `standingsOf` |
| [Re-Match](#re-match) | Replay with same rules/players, no lobby | `rematch_vote`, `MatchState.rematchVotes`, `createRematch` |
| [Visit](#visit) | One player's turn, up to three darts | `Visit`, `CurrentVisit`, `visits[]` |
| [Dart](#dart--throw) | One throw: board coordinates + score | `DartThrow` |
| [Locked visit](#locked-visit) | The mode will accept no further dart this visit | `CurrentVisit.locked` |
| [Voided visit](#voided-visit) | A finalized visit that scored nothing | `Visit.voided` |
| **[x01]** [Bust](#x01-bust) | x01's void: overthrown, or an impossible leave | `Visit.bust`, `isBustScore` |
| **[x01]** [Checkout](#x01-checkout) | x01's win: reaching exactly zero | `VisitResult.won` |
| [Mode view](#mode-view) | The mode's text for the current leg | `ModeView`, `ViewText`, `mode.view(ctx)` |
| [Mode panel](#mode-panel) | The mode's own block, across the match | `ModePanel`, `mode.panel(match)` |
| [Scorer](#scorer--scoring-device) | Paired camera device that reports dart tips | `deviceId`, `scorer_*` messages, `ScorerApp` |
| [Scoring](#scoring-and-the-two-power-stages) | A match is running that this device feeds | `scorer_state.scoring`, `resolveScoringTarget` |
| [Standby](#scoring-and-the-two-power-stages) | Device asleep: wake lock released, socket closed | `PowerStage`, `useScorerPower` |
| [Scoring context](#scoring-context-started-and-resumed) | The match and board a device feeds; a reconnect is not a new one | `scoringContextId`, `classifyScoringActivation` |
| [Media](#media) | The optional feature: p2p video between the devices in a match | `media.enabled`, `media_*` messages |
| [Peer](#peer--peer-id) | One live socket in one match media incarnation | `peerId`, `MediaPeer` |
| [Roster](#roster) | The peers a peer may connect to. **The authorization** | `media_peers`, `planFor` |
| [Link](#link--mesh) | One RTCPeerConnection between two peers | `PeerLink`, `peerLink.ts` |
| [Mesh](#link--mesh) | The links one client holds, and its one encoder | `Mesh`, `useMediaMesh` |
| [Media tier](#media-tier) | How much a device is willing to send | `MediaTier`, `media_ready` |
| [Board camera](#board-camera) | The source selected for one immutable match slot | `media_join` |
| [Region of interest](#region-of-interest) | A square of a board, asked for by name | `Region`, `clampRegion` |
| [Still](#still) | One photograph of a region, on request | `still_request`, `StillConfig` |
| [Dart evidence](#dart-evidence) | The still under a dart slot | `useDartEvidence` |

---

## Match structure

### User

A **user** is one frontend instance — practically, one browser tab running the gaming app. There
are no accounts, no logins and no persistent identity.

A user is identified by its **session id**: `crypto.randomUUID()`, minted by the server for every
WebSocket connection (the `connection` handler in [`src/server/index.ts`](../src/server/index.ts)) and pushed to the
client in the non-`ServerMessage` `connected` frame. Server-side, the per-connection record is
`Client` ([`src/server/types.ts`](../src/server/types.ts)).

Consequences worth knowing:

- A session id is **per connection, not per user**. A page reload produces a new one; the `reconnect`
  message re-binds the existing player to it by overwriting `player.sessionId` — on presentation of a
  [seat token](#seat), which is the only thing left that identifies the returning tab.
- Ownership checks ("only your own player", "only the creator may change settings") compare
  `client.sessionId` against `lobby.hostSessionId` / `player.sessionId` — **on the server, which is
  the only place either of those exists.** Both are stripped from every lobby and match on the way
  out, and the client is told the conclusions instead: `yourPlayerId` and `youAreHost`, addressed to
  one connection rather than broadcast to the room.
- Browser-level state that outlives the tab (paired scoring devices) lives in `localStorage`;
  tab-level state (which devices *this tab* is using) lives in `sessionStorage`. See
  [`deviceStorage.ts`](../src/client/lib/deviceStorage.ts).

Do **not** write "user" when you mean a player. In a local match one user owns two players.

### Player / Participant

A **player** is a participant in a match. Prefer **player** in code and UI; *participant* is
acceptable in prose when contrasting with users, but no identifier should use it.

```ts
interface Player { id: string; name: string; sessionId?: string }
```

- Player ids are `p1`, `p2`, … from a process-global counter
  ([`src/server/player.ts`](../src/server/player.ts)) — unique per server run, not per match.
- Server-side, every player carries the `sessionId` of the user who added it. In a **local** match
  both players carry the same session id; in an **online** match one player belongs to each user.
- **On the wire it is stripped** (`publicPlayers`, in
  [`connections.ts`](../src/server/connections.ts)): a lobby and a match go to the whole room,
  spectators with them, and whose player is whose is nobody else's business. That is why the field
  is optional — present on every player the server holds, absent from every player a client has
  seen. A client asking "is this one mine?" compares it against `yourPlayerId`, which is sent to one
  connection and never broadcast.
- A match is limited to **two** players (`addPlayerToLobby` refuses a third), and a local match can
  start with one.

### Lobby

The **lobby** is the first phase of a match: participants, match settings and game-mode settings are
configured here. It is a distinct entity (`Lobby`), not a status of a match.

- Created by `create_lobby`; the creating user becomes the **host** (`hostSessionId`).
- Always gets an invite code (`generateInviteCode`), even for a local lobby; the code is only shown
  for online lobbies.
- `isLocal` decides who may do what (see [Local vs. online](#local-match--online-match)).
- `remoteConnected` means a second user is present in an online lobby.
- Starting the match **destroys** the lobby: `createMatch(lobby)` calls `deleteLobby` and copies
  players and settings into the new match ([`createMatch`](../src/server/store.ts)).
- A lobby idle for 10 minutes is abandoned and deleted, and everyone in it is told
  ([`lifecycle.ts`](../src/server/lifecycle.ts)). Nothing collects it later: its deadline is
  the only way it ends.

### Match

A **match** is the entire contest between two players: it has a lobby phase, then play, and ends
either with a winner or by being abandoned/cancelled.

In code it is `MatchState` / `matchId` / `match_*`, and the match layer is
[`src/server/match.ts`](../src/server/match.ts). "Game" in this codebase now only ever means a
*game mode*.

A match is [sets of legs](#match-structure-sets-and-legs). The game mode reports that a leg was won
(`finalizeVisit → legWinnerId`) and **the match layer** decides what that means for the set and the
match ([`match.ts`](../src/server/match.ts)) — the mode is never told.

`MatchStatus` is `'in_progress' | 'finished'`; a match is created directly as `'in_progress'`.

How a match ends:

| Cause | Result | Screen says |
| --- | --- | --- |
| The game mode declares a winner (x01: a checkout) | `status: 'finished'`, `winnerId` set | "🎯 X wins!" |
| A player leaves an **online** match | The other player is declared winner | "🎯 X wins!" |
| The user leaves a **local** match | `status: 'finished'`, **no** winner | "Match cancelled" |
| Nobody touches it for 10 minutes | `status: 'finished'`, **no** winner | "Match cancelled" |

**A finished match with no `winnerId` was cancelled, not won** — that is what the screen keys on.
Any leave also records the player in [`departed`](#departed), which stands as their answer to a
re-match.

A finished match is not the end of the story: it lives out its summary and is then
[closed](#deadlines) for good.

Finished matches are kept 5 minutes, then garbage-collected.

### Local match / Online match

- **Local match** (`isLocal: true`) — one user, one board, both players added from the same frontend.
  That user controls everyone: any client in the lobby may start it, remove players, change settings,
  and darts are always attributed to whoever is currently up.
- **Online match** (`isLocal: false`) — two users, two boards. Each user may add exactly one player,
  only the host may change settings / player order / start the match, and a user may only throw,
  undo and submit for their own player.

`isLocal` is set at lobby creation and copied into the match. It is the single switch behind almost
every permission difference in [`wsHandler.ts`](../src/server/wsHandler.ts), and also decides how a
camera attributes darts ([`session.ts`](../src/server/scoring/session.ts)).

### Host / Creator

The user whose session created the lobby (`hostSessionId`). The UI calls this the **creator**
("Only the match creator can change settings"). `hostPlayerId` is separate and only set for online
lobbies — the first player the host adds.

`hostSessionId` is server-side, like a [player's](#player--participant): the client is **told**
whether it is the host (`youAreHost` on a `lobby_state` addressed to one connection) rather than
working it out by comparing session ids, which required publishing the creator's to the room. A
broadcast carries no answer at all, so it cannot overwrite the one a connection was given; `false` is
as much an answer as `true`, and a reload is told again from the [seat](#seat). `isCreator` in the
client is `isHost || lobby.isLocal`.

Pick one word in new code: **host** for the server-side session, **creator** in user-facing copy.

### Spectator

A read-only observer. A user becomes one via `spectate` on `/spectate/:id`, which sets
`client.isSpectator` and binds it to a lobby or match without adding a player. Spectators are
excluded from every gameplay guard, and explicitly from scoring: a spectator with a paired camera
must not score ([`resolveScoringTarget`](../src/server/scoringDevices.ts)).

`client.isSpectator` guards a *connection*, so it cannot be the whole answer: a page load is a new
connection, and nothing about a fresh socket says what the tab was doing a moment ago. What stops
watching from being reloaded into playing is that resuming a place requires a [seat](#seat), and a
spectator is never given one.

### Seat

A place in a room, and the token that proves it ([`seats.ts`](../src/server/seats.ts)). A room is a
lobby or a match; seats are carried from a lobby into the match it starts and from a match into its
re-match, because to the person holding one it is the same place all evening.

Minted when a connection takes a place — creating a lobby, joining one, adding a player — and sent
to that connection alone, in a `resume` message. The client keeps it in `sessionStorage` and presents
it on `reconnect`; **the seat then says what is resumed** (which player, and whether the host chair
comes with it), so there is nothing left in the message to lie about.

Three rules make it worth something:

- **A token is never broadcast and never rides on a lobby or a match.** Both of those go to everyone
  in the room, spectators included, so a secret kept on the player record would be published to the
  people it exists to exclude.
- **Watching is not a place.** No `spectate` grants a seat, and leaving revokes the one you had —
  which is the other half of [Departed](#departed).
- **A place has one occupant, and holding it is what permits acting.** Presenting a token takes the
  seat from whoever had it: they are out of the room before the newcomer is admitted, and are told
  (`seat_taken_over`) so their tab can drop what it holds — including the token, or the two would
  trade the place forever. Duplicating a tab copies `sessionStorage`, so this is the ordinary way it
  happens, not an attack. Every entry point into a lobby or a match then asks the seat rather than
  the connection's own record (`seatedInLobby` / `seatedInMatch` in
  [`wsHandler.ts`](../src/server/wsHandler.ts)) — a `Client` says what a connection was last told it
  may do, the seat says who may do it now, and a connection that no longer holds one cannot throw,
  submit, start, vote or leave.

**Separate tabs are separate users.** The token lives in `sessionStorage`, which is per tab, so two
tabs of one browser hold two seats and never contend — that is what lets one browser play both sides
of an online match. Only a *duplicated* tab arrives holding somebody else's place.

### Re-Match

A new match with the same rules and the same participants, started straight from a finished one with
**no lobby phase**, and with the player order switched so the other player begins.

A re-match is not a continuation and carries nothing over — not scores, not history, not who won. It
is an ordinary new match that skips the lobby because everything a lobby would ask for is already
settled ([`createRematch`](../src/server/store.ts)). Nothing anywhere records that a match came from
another one.

**Every participant gives a definite answer.** Each player starts *neutral* and either accepts or
declines (`rematch_vote`, held in `MatchState.rematchVotes` so both sides watch each other's answer
through the ordinary broadcast):

| All accepted | A re-match starts at once |
| --- | --- |
| Anyone declined | Settled: no re-match. The summary stays up until the [deadline](#deadlines) |
| Still neutral at the deadline | Becomes a decline, and the match closes |

There is no way to leave the question open. **Leaving counts as declining** — see
[Departed](#departed) — and the deadline answers for anyone who never did.

- A user may only answer for a player of their own session — which in a local match is all of them.
- When a re-match starts, everyone on the old match moves to the new one, **spectators included**.

### Departed

`MatchState.departed` — participants who have left. **Leaving a match is final**, whether by pressing
Leave, or by dropping the connection for longer than the reconnect grace period:

- they cannot reconnect to it — leaving revokes their [seat](#seat) ("Cannot resume this session"),
  and `departed` refuses them by name as a second line if a token ever outlives its revocation;
- only the connection **holding** the place may do it, so a tab whose place was taken over cannot
  concede a match it is no longer in;
- it counts as **declining** a [re-match](#re-match), and cannot be taken back by anyone;
- if it was still being played, it ends — see [Match](#match).

### Deadlines

Every lobby and every match carries an `expiresAt`, and
[`lifecycle.ts`](../src/server/lifecycle.ts) is the only thing that reads it. The point is that
nothing can sit on the server forever: a match is either being actively played, or counting down to
a definite end.

| State | Deadline | What happens |
| --- | --- | --- |
| Lobby | 10 min idle | Abandoned; everyone in it goes home (`lobby_abandoned`) |
| Match in progress | 10 min idle | Cancelled — finished, no winner — and gets a summary like any other |
| Match finished | 2 min | Neutral re-match votes become declines, then `match_closed`: everyone still on it, players and spectators, goes home and the match is deleted |

**Input pushes the idle deadline back**; the summary deadline is fixed. Input means anything a
participant does — darts (manual or from a scoring device), undo, submit, settings, adding or
renaming players, swapping order, starting the match, re-match votes. Spectating and reconnecting do
not count: an audience must not keep a dead match alive.

**A deadline is the only way anything is reclaimed.** There is no collector sweeping for abandoned
objects, and deliberately so: one would hide the bug it exists for, quietly tidying away whatever a
broken path forgot to delete and leaving nobody any the wiser. Every lobby, match and scoring
session is deleted by the path that ends it —
[`tests/unit/retention.test.ts`](../tests/unit/retention.test.ts) plays a match to each of its
endings and asserts the stores are empty afterwards, which is what holds that true. `/server-stats`
reports the same counts live, so a leak would show as a number that never returns to zero.

The client counts the summary deadline down on the finished screen, since it is what turns an
unanswered re-match into a decline.

### Invite code

Six characters from an unambiguous alphabet (no `I`, `O`, `0`, `1`), attached to a lobby and used to
join an online match: `/lobby/join/:code`. Regenerated when a joiner leaves. Not to be confused with
a scoring device **pairing code**, which uses the same alphabet and length but a completely separate
mechanism.

---

## Match structure: sets and legs

A **match** is a number of sets; a **set** is a number of legs; a **leg** is one play-through of the
game mode. Both counts are match settings with a minimum — and a default — of 1, so a single
play-through is the same code path as everything else and needs no special case.

### Leg

One instance / play-through of a [game mode](#game-mode), ending when that mode declares a winner
(in x01: a checkout). The winner of a leg is not automatically the winner of the match.

A leg is **mode-agnostic**: "first to *n* legs" means the same thing whatever the mode inside it is,
and the leg and set layer is written in terms of no mode's rules.

- `MatchState.visits` is the **current leg's** visits. A finished leg moves into `MatchState.legs` as
  a `CompletedLeg` — its visits and its winner.
- A new leg therefore needs no reset: it starts with an empty visit list, and everything a mode
  derives starts over with it.
- A finished match has no current leg, and needs none: its summary is the
  [match's](#the-summary-screen), not the mode's.

### Set

A group of legs, won by the first player to take `legsToWinSet` of them.

Single-leg sets are allowed deliberately so there is only one code path: a match with "first to 3
sets, first to 1 leg" plays identically to "first to 3 legs". The player card presents that case as
legs only — display, nothing more.

### Standings

Where a match stands: sets won, and legs won **in the set being played** (which resets when a set is
taken). Never stored — derived by replaying the ordered leg winners in
[`shared/matchFormat.ts`](../src/shared/matchFormat.ts), the same "one source of truth" discipline
that keeps a game mode stateless.

Shared, so the server decides the match with it and the screen displays it with it — one
implementation, and nothing derived on the wire. The player card reads `2S | 3L`, or `5L` when a set
is one leg.

### The summary screen

What a finished match shows. Deliberately **match-level**: the player cards give winner and loser
rather than a score, and the scoreline is legs per set, read like a tennis result
([`MatchHistory`](../src/client/components/MatchHistory.tsx)).

The game mode contributes exactly two things — the headline, so it still says what was played, and
its optional [panel](#mode-view), which is where a mode may put statistics of its own. Everything
else is the same whatever was played inside the legs.

### Who throws first

The throw alternates every leg, **and every set alternates independently of how the last one ended**:
the first player starts sets 1, 3, 5 and the second starts sets 2, 4, 6, whoever won what. A player
who takes a set 3–1 — winning its last leg — still throws first in the next set.

Derived, not stored: `(setsPlayed + legsInCurrentSet) % playerCount`
([`starterIndex`](../src/shared/matchFormat.ts)). `swap_players` in the lobby decides who is "first
player" to begin with.

---

## Play — mode-agnostic

Everything in this section is true of any game mode. The words a mode uses for its *own* rules go in
[x01 vocabulary](#x01-vocabulary).

### Visit

One player's turn at the board: up to three darts. Also called a *turn* colloquially — prefer
**visit** everywhere.

Two shapes exist, deliberately:

- `CurrentVisit` — the visit in progress: `{ playerId, darts, locked }`. Lives on
  `MatchState.currentVisit` and is `undefined` between visits. Darts arrive one at a time (`add_dart`)
  and can be taken back (`undo_dart`, LIFO).
- `Visit` — a finalized visit appended to `MatchState.visits[]`:
  `{ playerId, darts, visitNumber, bust }`.

**Submitting** a visit (`submit_visit`) is what finalizes it. What that does — whether it counts,
whose turn is next, whether anyone won — is entirely the mode handler's decision
([`GameMode.finalizeVisit`](../src/server/modes/types.ts)). Submitting with zero darts is legal;
x01 commits it as three misses.

**How many darts a visit holds is the mode's**: `mode.dartsPerVisit(settings)`, enforced by the
match layer and shipped to the screen as `view.dartsPerVisit`. x01 says three. The client's slot row
is still laid out as if three were the only answer — see the
[remaining leaks](#mode-specific-vocabulary-in-mode-agnostic-layers).

### Locked visit

`CurrentVisit.locked` — **the mode will accept no further dart in this visit.** The generic contract
is just that: the match layer appends a dart, asks `mode.isVisitLocked(ctx)`, and the UI stops
offering the board.

A locked visit is **not** an ended visit. It stays open until it is submitted, which is deliberate:
the gap is when a misread dart gets corrected. See [takeout](#tip-throw-window-tracked-dart-takeout).

Why a visit locks is the mode's business. x01 locks on three darts, on reaching zero, or once the
visit is already bust.

### Voided visit

A finalized visit that **scored nothing**: `Visit.voided`. The mode sets it; nothing outside the
mode asks why. x01 calls its own instance of this a [bust](#x01-bust).

### Winning

The mode reports `legWinnerId` from `finalizeVisit`; the match layer writes `winnerId` and `status`.
The generic concept is "the mode has decided this player won the leg" — *how* is never the match
layer's business, and *what a won leg means for the match* is never the mode's.

**A leg always ends with a winner.** That is a contract, not a convention: match logic (first to *n*
legs, first to *m* sets) is built on it holding for every mode.

### Dart / Throw

`DartThrow` — `{ x, y, score }`, where `x`/`y` are **board coordinates** and `score` is a
`ScoreResult`. Use **dart** for the object; *throw* is fine in prose for the act.

The server **always recomputes** the score from the coordinates and ignores any client-supplied
score ([`validateDartThrow`](../src/server/validation.ts)). A dart is its position; the number is
derived.

### Board coordinates

Integer space `[0, 1_000_000]²`, centre `(500000, 500000)`, **y-up** (top of the board, above the 20,
is `y = 1_000_000`). Defined and scored in [`src/shared/scoring.ts`](../src/shared/scoring.ts). Both
the manual dartboard UI and the cameras speak this space, which is why they can share one code path.

### Score / ScoreResult

`{ label, points, mult, base }`. Labels: `S20`, `D20`, `T20`, `SB` (outer bull, 25), `DB` (bull, 50),
`miss`.

This is a property of the **dartboard**, not of any game mode: where the dart landed and what that
segment is worth. What a mode *does* with it — subtract it, ignore it, require `mult === 2` — is the
mode's business. `scoreFromBoardCoords` is shared by the manual board, the cameras and every mode.

### Game Mode

How one [leg](#leg) is played and won, plus the settings those rules need. Two exist: **x01** and
**[Whac-A-Mole](#whac-a-mole-vocabulary)**. Full contract in [game-modes.md](./game-modes.md).

- The rules are `GameMode` in [`server/modes/types.ts`](../src/server/modes/types.ts):
  `dartsPerVisit`, `isVisitLocked`, `finalizeVisit`, `view`. Modes register themselves at boot and
  are looked up by `settings.mode`.
- A mode is **pure functions over a [`LegContext`](../src/server/modes/types.ts)** — settings,
  players, whose visit it is, the committed visits and the visit in progress. It holds no state:
  anything it needs, it derives from the visit history.
- A mode declares its own settings — label, defaults and fields — in its own file, and the server
  sends that catalog to the client on connect (`mode_catalog`). Both the lobby panel and the server
  validator read the same declaration; the client imports no mode code.
- **A mode is a file, plus one line.** `src/server/modes/<id>.ts` registers itself at import time,
  and [`registry.ts`](../src/server/modes/registry.ts) is the explicit list of which files get
  imported — so what a build ships with is decided in the source, not by what is on disk. x01 is
  mandatory: the server refuses to start without it.
- A mode **cannot** end a match, advance the turn or write match state. It reports a leg winner and
  the match layer takes it from there.
- A mode supplies the match screen's mode-specific strings through its [view](#mode-view).

Say **game mode** (or *mode*), never just "game", for this concept.

### Mode view

`ModeView` — everything mode-specific the match screen shows: headline, notice, per-player card
score, visit total, darts per visit, optional slot contents, history lines, and an optional payload
for the mode's own screen element.

Computed by the mode **on the server** (`mode.view(ctx)`) and shipped with every `match_state` /
`match_started` / `match_finished` message, so the client holds no rules. Player card scores are
text, not numbers — that is what lets x01 put "Bust!" where a score would be without the screen
knowing what a bust is.

Each piece is a **`ViewText`**: a bare string, or a string with optional hints — `tone` (semantic:
`danger`, `warning`, `positive`, …), `size`, `weight`. Hints are meanings, not CSS; each element
supplies the defaults for whatever the mode leaves out, and
[`modeText.ts`](../src/client/components/modeText.ts) is the only place that decides what a tone
looks like. See [game-modes.md](./game-modes.md).

### Mode panel

`ModePanel` — the mode's own block of the match screen, and its vehicle for extending the match UI.

Owned by the **match**, not by a leg: `panel(match)` is handed the whole `MatchState`, because a
statistic is about the match and an average read off one leg would change every time a leg ended. It
is safe to show it everything precisely because it can only return something to draw — nothing it
returns reaches the rules.

Declarative (a title, leg-wide `lines`, and rows of label → per-player value), so a mode showing
statistics needs no client code. A mode may also add `src/client/modes/<id>.tsx` — picked up by
filename — which **replaces** the generic table and receives the whole panel, including a `custom`
payload of its own. x01 does both: the rows work on their own, and its component lays them out per
player and draws recent scoring as bars.

---

## x01 vocabulary

**Everything below belongs to the x01 mode.** These words describe x01's rules, not the app's model.
A different mode may have no equivalent — a mode where both players always throw the same number of
visits and nothing can be overthrown has no bust and no checkout, only "the mode decided who won".
Do not use these terms in match-level, protocol-level or scoring-device-level code or prose.

### [x01] Start score

`modeSettings.startScore` — what each player counts down from. Declared by x01 in
[its own file](../src/server/modes/x01.ts): a number field, 101–999, offered as 301 / 501 / 701.
Defaults to 501.

### [x01] Remaining score

What a player still has to score. **Derived, never stored**: `getRemainingScore` replays every
non-void visit in `game.visits` and subtracts it. This is why the concept cannot survive multiple
legs in one flat array unchanged.

### [x01] Double in / Double out

- **Double in** — the first *scoring* dart must be a double; darts before it score nothing, and a
  visit that never hits one is void. Whether a player has satisfied it is **derived**: they have a
  committed non-void visit containing a double. (Note "containing a double", not merely non-void —
  a zero-dart submit commits three misses as a non-void visit and must not count.)
- **Double out** — the winning dart must be a double (or the bull) landing exactly on zero.
- **Straight out** — double-out off. Used in the match screen's heading.

### [x01] Bust

x01's [voided visit](#voided-visit): the visit total would take the remaining score below zero; or,
under double-out, would leave exactly 1, or would reach 0 on a non-double.

Leaving exactly 1 is a bust **only** under double-out — with straight out, a single 1 checks it out.
A busted visit is committed with `bust: true`, scores nothing, and ends the turn immediately.

Say **bust** only about x01. The mode-agnostic word is *voided visit*.

### [x01] Checkout

x01's win condition: reaching exactly 0, on a double if double-out is on. Wins the leg — today, the
match. The mode-agnostic surface is `VisitResult.won`.

---

## Whac-A-Mole vocabulary

**Everything below belongs to the Whac-A-Mole mode**
([its own file](../src/server/modes/whac-a-mole.ts)), a co-op training mode for one player or two.
As with x01's words, do not use these outside it.

### [wam] Area

One scoring region, and the unit this mode targets: `S20o` outer single, `S20i` inner single, `T20`,
`D20` and `BULL` — eighty-one of them. Finer than a [ScoreResult](#score--scoreresult) in one
direction and coarser in the other: it splits `S20` into the two singles, which takes the dart's
[board coordinates](#board-coordinates) as well as its label, and it merges both bulls into one
area, because the middle of the board is not a target here (see [the burrow](#wam-the-burrow)).

### [wam] Mole / dig time / hole

A mole occupies an area and is **whacked** by a dart landing in it, for one point. Its **dig time**
(`digTime`) is how many visits it takes to get through; a mole nobody stops is buried and its area
becomes a **hole** for the rest of the run. A dart in a hole costs its thrower one dart per visit,
from their next visit onwards.

Dig time is fixed when a mole spawns, not read from the round it is currently in, so crossing an
[enrage](#wam-enraged--frenzy) threshold never buries a mole that was already halfway down.

### [wam] The burrow

`BULL` — both bulls as one area, and a hole before the first dart is thrown. It is where the moles
came from, no mole ever comes up in it, and a dart that lands there costs one like any other hole.
Every dart lost to any hole is held in the burrow, oldest first.

### [wam] Janitor

The one mole that is not a target but a rescue. With at least one dart in [the
burrow](#wam-the-burrow) it is up on even odds each visit, holding the oldest of them; hitting the
burrow while it is there hands that dart back **to whoever lost it**, which need not be the player
who threw — the one move in the mode a player makes for their partner. It scores like any other
mole, and one dart a visit is the limit: the janitor goes home the moment it is hit, and the middle
is an ordinary hole again for the rest of that visit. Like a loss, a rescue changes the allowance
from the owner's *next* visit, which is why the screen marks that dart `↺` rather than `✖`.

### [wam] Run / round / curtain call

A **run** is one leg. A **round** is one visit for each player. A run ends when the rounds are up or
when nobody has a dart left; either way the next visit is the **curtain call** — no darts, locked
from the start, and submitting it is what ends the leg. It exists so the closing screen is seen: the
match summary does not draw a mode's panel.

### [wam] Seed

The number a whole run is computed from. Every mole's area, every reaction and every taunt comes out
of it, so two runs on one seed open identically and part company as soon as the first dart lands —
each committed visit folds its dart coordinates back into the PRNG.

It reaches the rules the only way a per-match number can: as a **setting**. A mode's rules see a
[LegContext](./game-modes.md#what-a-mode-may-look-at-legcontext) and nothing else — no match id, no
leg number — so `defaults` is a getter that draws a fresh seed each time it is read, and
`validateSettings` stamps one into the lobby when the mode is chosen. `seed` is deliberately absent
from the mode's `fields`, which is what makes it unsettable: the validator reads declared fields and
nothing else, and the lobby never draws a box for it.

A re-match copies the previous match's settings, seed included, so it opens on the same three moles.

### [wam] Enraged / frenzy

Three-fifths of the way through the rounds, newly spawned moles lose a visit of dig time
(**enraged**); four-fifths of the way, another (**frenzy** — they have to be whacked in the visit
they appear).

### Mode-specific vocabulary in mode-agnostic layers

Kept as a standing check. Every row here was true before the mode boundary was untangled; the ones
that remain are the constraints a second game mode will meet.

**Cleared:**

| Was | Now |
| --- | --- |
| `Visit.bust` — an x01 word in the shared visit type | `Visit.voided`; the mode decides, nothing else asks why |
| `doubleIn` / `doubleOut` / `startScore` flat in the settings type | `MatchSettings = { mode, modeSettings }`; the mode declares its own fields |
| `getRemainingScore` in the generic handler contract | gone from the contract — a countdown is x01's business alone |
| `validateSettings` naming x01 fields | validates against the mode's declared fields |
| The store writing x01's defaults at lobby creation | writes `defaultSettingsFor(DEFAULT_MODE)` |
| The camera layer re-deriving x01 bust rules (`isAlreadyBust`) | asks `currentVisit.locked` — the mode's own answer |
| The match screen re-implementing remaining score, double-in and bust/checkout display | renders `ModeView` strings; knows no rule |
| `GameSettingsPanel` rendering x01's three settings | `MatchSettingsPanel` renders the mode's declared fields, from the catalog the server sends |
| The screen deciding a card score was a verdict by testing whether the string was numeric | x01 sends a `danger`/`warning` tone with the word |
| The screen colouring a dart slot by whether the dart scored above zero | x01 tones its own slots |

**Remaining:**

| Leak | Where | Why it is still there |
| --- | --- | --- |
| Three darts per visit is assumed by the client's fixed-width slot row, though the count itself comes from `view.dartsPerVisit` | [`VisitInput.tsx`](../src/client/components/VisitInput.tsx) | Layout, not logic: the row is sized for three. Whac-A-Mole is the first mode to offer more — up to five — and the row holds, because each slot is `flex-1` under a maximum rather than a fixed width |
| A mode's own component reaches the dartboard through the DOM (`[data-testid="dartboard"]`) rather than through a slot the match screen offers it | [`client/modes/whac-a-mole.tsx`](../src/client/modes/whac-a-mole.tsx) | `ModePanelProps` is the panel and nothing else, so a mode that draws **on** the board — rather than beside it — has no other way in. The alternative is a board-decoration channel in `ModeView`, or a slot threaded through `MatchScreen` → `VisitInput` → `Dartboard` |

---

## Scoring devices

### Scorer / Scoring device

A paired device running the AI detection app at `/scorer`: it watches the board with its camera and
reports **dart tips** to the server. Several can be combined for one board to improve detection.

- **Scorer** and **scoring device** are used interchangeably; wire messages use the `scorer_` prefix,
  most server-side identifiers say `device`.
- The scorer app is a **sibling** of the gaming app, not a route inside it: separate socket, separate
  storage keys, mounted from [`main.tsx`](../src/client/main.tsx) by path.
- A WebSocket connection is **either** a frontend **or** a scoring device, never both — that
  distinction is `Client.deviceId` and it gates message routing.
- A scoring device never holds match state. It receives only a projection (`scorer_state`).
- A device **decides its own power**. The owner can *ask* — `set_device_camera`, `power_off_device`,
  forwarded to the device as `scorer_command` — but stopping a camera is the only one of those that
  cannot fail, and the device's own `scorer_camera` report is the only account of what actually
  happened. Never render a request as if it were a state.

### Pairing, claiming ("grabbing"), and the camera

Three separate states, in order:

1. **Paired** — a device belongs to a browser. The device stores `{deviceId, token}`, the frontend
   stores `{deviceId, tokenHash}`; the server stores neither across a restart, which is what makes a
   restart survivable. Established by a 6-character **pairing code** minted by the frontend and
   redeemed by the device.
2. **Active / claimed / grabbed** — a paired device is bound to exactly one frontend session
   (`activate_devices` / `deactivate_device`). "Grab" is the client-side word
   ([`useScoringDevices`](../src/client/hooks/useScoringDevices.ts)), "claim" the server-side one
   ([`devices.ts`](../src/server/devices.ts)). They mean the same thing.
3. **Camera active** — the device has actually started its camera (`scorer_camera`). Only such
   devices count as cameras for fusion and quorum.

**Online** means the device currently has a socket open. Paired ≠ online ≠ active ≠ camera active;
the distinctions are load-bearing, so keep them apart in prose too. A fifth, for
[media](#media): a device that is active with its camera on is still watchable by nobody unless it
is willing ([media tier](#media-tier)) *and* nominated ([board camera](#board-camera)).

### Scoring, and the two power stages

- **Scoring** (`scorer_state.scoring`) — a match is running that this device's tips would feed. A
  fourth state after the three above, and not the same as *active*: a device claimed all evening
  between legs is active the whole time and scoring only during it. The server answers it with
  `resolveScoringTarget`, the same call that decides whether tips are accepted, so the device and
  the server cannot disagree.
- **Camera off** — the first power stage. Camera and motion detector stopped after the grace period
  (default 2 min) with nothing to score. Reversible without anyone present: a match starting brings
  it back.
- **Standby** — the second. Wake lock released and the socket deliberately closed, after the longer
  delay (default 30 min). **One-way**: nothing can wake a sleeping phone, so only a tap on the
  device itself comes back from it. Say "standby" or "asleep", not "off" — the app is still loaded.
- **Power off** — the owner sending a device to standby from the frontend. The same end state,
  reached deliberately rather than by a clock. There is no matching power *on*.

Both stages are decided by [`lib/scorerPower.ts`](../src/client/lib/scorerPower.ts) and belong to
the device: the server never switches anything off, it only says whether a device is scoring.

### Scoring context, started and resumed

**Scoring context** — the match and the board a device is currently feeding, identified on the wire
by `scorer_state.scoringContextId`: an opaque hash of the match id and the owning player, stable
across socket reconnects, and different for a new match, a re-match, or another player's board. The
device is given the hash and never either identifier.

It exists because `scoring` alone cannot tell a reconnect from a match start — a socket that drops
and comes back makes it go false and then true again. Read as a match beginning, that edge would
restart a camera its owner had deliberately switched off.

So each fresh state is classified against the one before it
([`lib/scorerReconnect.ts`](../src/client/lib/scorerReconnect.ts)):

- **Started** — a context this device was not in. A new match, a re-match, or being claimed into one
  already running. This is what may bring a camera back on its own.
- **Resumed** — the same context, arriving on a replacement socket. Not a match start: the device was
  already scoring and still is. A camera comes back only if this device's own timer was what stopped
  it.

"A reconnect is not a match start" is the rule; *started* and *resumed* are the words for the two
halves of it.

### What belongs to the pairing, and what belongs to the phone

Unpairing throws away the **identity** — the `deviceId` and token — and nothing else. Everything
that describes the hardware survives it: the device's **name**, its lens calibration, its remembered
camera and zoom, and its power delays. A phone somebody labelled "Board camera" and mounted above
their board is still that phone after it is handed to another browser, and it says so as soon as it
pairs.

The distinction is worth keeping in prose too: a *pairing* is a relationship, a *device* is a thing
on a wall.

### Tip, throw window, tracked dart, takeout

- **Tip** (`BoardTip`) — one observation of a dart tip in board coordinates, already projected by the
  device. Devices send tips, never scores.
- **Throw window** — the short server-side window in which reports from several cameras about the
  *same* throw are fused into one set of darts ([`throwWindow.ts`](../src/server/scoring/throwWindow.ts)).
- **Tracked dart** — a dart the fusion layer believes is currently stuck in the board; this is what
  stops a dart from being counted again on the next frame ([`tracker.ts`](../src/server/scoring/tracker.ts)).
  Tracked darts live exactly as long as the visit they belong to, and nothing shorter clears them —
  an empty board too weak to end the visit leaves them tracked. One inference missing a dart that is
  still in the board is ordinary and is most of what tracking is for; a dart leaving the board
  mid-visit means one fell out, and only matters if the next dart lands close enough to be taken
  for it. So the tracker keeps its darts and the rare case is corrected by hand, rather than the
  common one producing a phantom duplicate dart.
- **Takeout** — the player pulling the darts out, signalled by an **empty tip array** from every
  active camera. An empty array is meaningful, never a no-op; a malformed report is dropped whole so
  it can never be mistaken for one. Takeout is what submits a visit automatically — a full visit does
  not, deliberately. How many darts must be in the board before a takeout is believed is decided by
  `armThreshold`: two with a single camera, one when several agree, and one for a visit the mode has
  locked.
- **Scoring session** — the per-(match, owning player) object that owns the throw window and tracker
  ([`scoring/session.ts`](../src/server/scoring/session.ts), keyed in
  [`scoring/store.ts`](../src/server/scoring/store.ts)).

---

## Media

The optional feature that carries video and stills peer-to-peer between the devices already in a
match. Full write-up in [media.md](./media.md); this section is the vocabulary.

Stills provide dart evidence, and live video replaces the read-only virtual board. In online matches,
spectators receive both boards and follow the thrower while each participant may receive only the
opponent's board. In local matches, spectators may receive the one physical board shared by both
players. Participants never receive their own board video.

Say **media** for the feature. Never "stream" (unused, and ambiguous between a `MediaStream` and the
thing a viewer watches) and never "call" — nobody rings anybody.

### Peer / peer id

One live connection taking part in one match media session: a frontend or scoring device, addressed
by an opaque **peer id** the server mints per match/socket incarnation.

Deliberately not a session id and not a device id. Neither of those should be handed to the person
you are playing against, and a peer id says nothing about what it names. A new socket means a new
peer id; a new match also means a new `meshId`, peer ID, and every link rebuilt. Lobbies have none.

A frontend becomes a peer through `media_join` for a running match. A disabled declaration completes
setup without becoming a peer. `media_ready` is a scoring device's capability announcement, not a
request for lobby topology.

For a scoring device, being a peer takes **two** answers rather than one: see
[media tier](#media-tier) and [board camera](#board-camera).

### Media tier

`MediaTier` — how much a peer is willing to send: `disabled`, `stills` or `video`. A scoring device's
own answer, set on the phone, and nobody else's to change: not its owner's and not the opponent's.

It says what the hardware *offers*, never that it is in use. `stills` and `video` differ only in what
a viewer should expect and ask for — the server allows both the same link with the same channels.
`disabled` is the only one that is a rule, and it is the rule that the device appears nowhere.

### Board camera

The one scoring device a user is sharing, chosen from those their tab has
[claimed](#pairing-claiming-grabbing-and-the-camera). At most one, and **none** is a real answer.

The second of the two gates: the running match's stable source slot selects the device only after its
frontend declares it. The choice survives replacement of that frontend endpoint, but explicit
opt-out, source change, device withdrawal, or match finish ends it.

Distinct from the browser's own media switch: that decides whether this user takes part at all
(including watching the opponent), while this decides only whether anybody sees *their* board. The
two are separate answers, and the device menu keeps them consistent rather than merged — nominating
a board turns the media switch on, because asking to be watched by a browser that takes no part in
media is not a state worth having, and while that switch is off no board is nominated on the wire at
all. The nomination itself is only remembered across that, not cancelled, so switching media back on
restores the board already chosen.

In the top bar, none is what every board-camera switch being off *says*, rather than a control of its
own: one switch per device, and turning one on turns the others off.

### Publisher / viewer

### Roster

The peers the server offers a given peer, published as `media_peers` and pushed on every change.

**The roster is the authorization.** A signal is relayed only between two peers that appear in each
other's roster, recomputed as the message arrives. There is no other rule.

It is authoritative in both directions: a peer that has vanished from a roster is a link that closes,
and that is the only teardown mechanism in the feature. Leaving a match, a match closing, a phone
dropping off the Wi-Fi and a browser opting out all reach the client as the same event — a name
missing from a list — so none of them has a message of its own.

Both endpoints of a pair come out of one computation (`planFor`), so the two sides can never disagree
about whether they are paired, which is **polite**, or who may send to whom.

### Media session

One server-private coordinator object for one running match, identified by a fresh `meshId`. A lobby
has no media session. A rematch destroys the old mesh and creates a new one; no peer connection,
source epoch, feed UUID, or consent crosses that boundary.

### Link / mesh

A **link** is one `RTCPeerConnection` between two peers. It carries **no media tracks** — only two
datachannels, `control` (reliable) and `media` (unreliable). A **mesh** is the set of links one
client holds, and the owner of its single encoder.

The encoder belongs to the mesh and not to a link, and that is the whole reason a link has no track:
every peer connection would otherwise encode independently, so a phone with four viewers would run
four encoders. See [media.md](./media.md#why-a-link-carries-no-video-track).

The two ends of a link. A scoring device only ever publishes — it is a board camera, and never
decodes anybody's picture. A [spectator](#spectator) is the mirror image and only ever views, and is
last in the priority order when links are rationed. Between two frontends it is symmetric.

Both directions are about *media*: the control channel is open both ways regardless, or a viewer
could not ask a camera for a keyframe. Say **viewer** for the receiving end, not "subscriber" or
"audience" — the audience is the spectators, which is a different idea.

### Region of interest

A square of a board, named in **normalized board space**: a centre and one side length, all in
[0,1]. `{0.5, 0.5, 1}` is the whole board and is what asking for no region means.

Board space rather than anything about a camera, so a request says *what to look at* and never
*where to point* — the same region means the same thing from any camera, and the asker needs to know
nothing about lenses or angles.

**The capturing device decides what is valid.** `clampRegion` moves a centre that would fall off the
edge *towards the middle* rather than rejecting it or shrinking it, because a dart in the 20 bed is
near the top and the useful answer is the closest square that still holds it.

### Still

One photograph of a [region](#region-of-interest), taken on request and delivered over the control
channel — as against the continuous match video flowing on the media channel.

Only the [owner](#board-camera) may ask, and the request says which [audience](#audience) the answer
is for. That asymmetry is the whole shape of it: an opponent and a spectator see what the owner's
camera was asked to show them and have no say in what that is. [Dart evidence](#dart-evidence)
addresses all three roles.

Every still is a square JPEG of one size, whatever region it was asked for. The size is a
[deployment setting](#deployment-settings) (`media.still.size`) and reaches both ends of a link through
`app_config`; its mime and quality are not tuneable and stay in `STILL` in `shared/media.ts`.

### Dart evidence

The [still](#still) under a dart slot: a close-up of where that dart actually landed, requested by
the thrower as each dart appears in the visit and shown identically to everyone watching.

Belongs to the visit in progress. Undo takes the picture with the dart, and submitting the visit
clears the row along with the slots above it.

### Board video

A square live picture from a [board camera](#board-camera). Before a
[director command](#director-command) selects a smaller board region, it opens on the camera
stream's centred square—the same base crop scoring, motion detection, still geometry, and the local
preview use. The [tier](#media-tier) has to be `video`. The server sends the selected scorer a
retained `media_source_state` with a source epoch and audience; the camera creates one feed UUID for
that epoch and announces it to each eligible peer. Frames are encoded once and written only to
exact eligible recipients that accepted that UUID.

A participant frontend reload keeps the source epoch and feed. A scorer replacement, source change,
tier reactivation, match finish, or rematch ends it. Temporary link/camera failure pauses encoding
without discarding consent for the same eligible peer and feed.

During an in-progress online match, each owner addresses their nominated camera's offer to `opponent`
and `spectator`, never `owner`. Each recipient accepts or declines independently and can change that
choice from the board controls. Participants display accepted video only on the opponent's turn;
spectators display the current player's accepted feed. A local match addresses its single shared
board camera only to spectators, who display it for both players' turns. Declined, missing or
three-seconds-stale video uncovers the virtual board. See [docs/media.md](./media.md#live-board-video).

### Audience

Which kinds of viewer a result is for: `owner`, `opponent`, `spectator`. Carried by `still_request`
or the retained server source directive, and read off the roster's `role`, which is the one thing in a
roster a client could not work out for itself — nothing else in it says who is only watching.

For live video the audience is permission to receive an offer, not automatic delivery. A peer must
also accept the current feed UUID, and the camera intersects that exact peer choice with the current
audience and roster on every frame.

**It fails closed.** A list that is missing, empty or unrecognisable is read as `['owner']`, never as
everybody: a sender that gets this wrong should be able to cost a picture and never to put a live
board in front of a stranger. See `clampAudience`.

### Director command

`video_region` — telling a camera which square of the board to look at, how long to take getting
there, and how long to stay. The same [region](#region-of-interest) vocabulary a [still](#still) uses,
plus the two things a moving picture needs that a photograph does not.

The owner's alone, like every command except a keyframe request. Dart evidence issues one for each
dart, at the same square it photographs.

The production dart-evidence path issues this alongside the still request, so remote live viewers see
the same per-dart camera move. No interface issues one by hand.

**Fire-and-forget, which is why a shot expires.** Leave the transition out and the camera cuts; leave
the reset out and it comes back after `media.virtualCamera.resetMs` anyway. Nothing guarantees a second
command is coming, and a camera stuck on the last dart of the evening is worse than any framing.
`resetMs: 0` is how a caller that will send the release says so — and dart evidence, which will not,
names both timings outright rather than leaning on the default.

### Virtual camera

How a director command is honoured without a lens that moves: the shot is the source rectangle of one
`drawImage`, and a camera move is those numbers interpolated over the transition. See `videoCamera.ts`.

Its destination is re-resolved every frame rather than fixed when the command lands, which is what
lets a feed open on the camera stream's centred square before the board has been located and slide
onto the board the moment it is. A move that is interrupted departs from wherever the shot had
reached, so a second command — or a reset arriving mid-swing — reads as one continuous camera.

---

## Settings

Three different things are called *settings*, and they belong to three different people. Keeping
them apart is the whole of this entry; when the distinction matters, name it.

| | Who sets it | Where it lives | Scope |
| --- | --- | --- | --- |
| **Deployment settings** | whoever runs the server | `instadarts.config.jsonc`, one optional file | the whole deployment |
| **Match settings** | the lobby's host | in the lobby, then the match | one match |
| **Device settings** | the person holding the phone | that browser's own storage | one device |

### Deployment settings

The knobs an operator turns: how big the server may get, whether it carries media, the numbers a
camera and a publisher run by. Declared once with their defaults in
[`shared/config.ts`](../src/shared/config.ts), read from the file by
[`server/config.ts`](../src/server/config.ts), and **entirely optional** — with no file, the defaults
are the deployment.

Four sections: `server`, `frontend` (⏳ empty), `scorer`, `media`. The last three are needed by code
running in a browser, which has no file to read, so the server sends a client its share as
[`app_config`](#app-config) on connect. The `server` section stays on the server.

**Never a user setting.** Anything a person can change from the app's own screens is a *device* or a
*match* setting; this file is for what an operator decides once. See
[development.md](./development.md#settings).

### App config

`app_config` — the message carrying a client's share of the [deployment settings](#deployment-settings),
sent to frontends and scoring devices alike on connect, beside `mode_catalog`. Sent even when media is
off, so nobody waits for a message that will never come.

On the client it lands in [`lib/appConfig.ts`](../src/client/lib/appConfig.ts), a module-level store
rather than React state, because the things that read it are not all React — the vision runtime, the
camera and the still capture are plain modules built once and driven by callbacks.

One value is not delivered as written. **`internal`** in `media.iceUrls` names the STUN server the
deployment carries itself, and is the only setting the *client* finishes: the server has no reliable
way to know its own public address, so it sends the word and the client turns it into
`stun:<the host this page came from>:<stunPort>`. The server drops it instead when nothing came up
behind it, so a client is never sent to a closed port. See
[media.md](./media.md#ice-and-why-video-may-simply-not-work).

### Match settings and device settings

**Match settings** are `MatchSettings` — the mode, the mode's own `ModeSettings`, and the
legs/sets format. Set in the [lobby](#lobby) by the host, validated against the mode's declared
fields, and fixed for that match. See [game-modes.md](./game-modes.md#settings).

**Device settings** belong to one phone or one browser and outlive any match: a scoring device's
name, its lens calibration, its remembered camera and zoom, its power delays, its
[media tier](#media-tier). Stored locally ([`scorerStorage.ts`](../src/client/lib/scorerStorage.ts))
and, notably, they survive unpairing — see
[what belongs to the pairing](#what-belongs-to-the-pairing-and-what-belongs-to-the-phone).

---

## Conventions

- **One word per concept.** match / player / user / visit / dart / leg / set / game mode. If you need
  a synonym to make a sentence read well, use it in prose only, never in an identifier.
- **Mark mode-specific words as mode-specific.** *Bust*, *checkout*, *remaining score*, *double in*,
  *double out*, *start score* are x01's, and belong in x01 code, x01 docs and match-screen copy that
  is showing an x01 match. In mode-agnostic code say what the *mechanism* is: the visit is **locked**,
  the visit is **void**, the mode declared a **winner**.
- **Before using a rule word, check the layer.** The protocol, the store, the lobby, the scoring
  devices, the match screen and the match/leg/set structure must all work for a mode that has no
  busts, no countdown and no checkout. The standing check is
  `grep -rE 'startScore|doubleIn|doubleOut|bust' src` — outside `server/modes/x01.ts`
  it should return nothing but comments and dartboard geometry. If you add
  a row to
  [Mode-specific vocabulary in mode-agnostic layers](#mode-specific-vocabulary-in-mode-agnostic-layers),
  that is a deliberate exception, not a shortcut.
- **`game` in code means a game mode, and nothing else.** The match is `match` everywhere:
  `matchId`, `MatchState`, `match_*`. `GameMode`, `LegContext` and `ModeView` are the mode's.
- **Say "scoring device" or "scorer", not "camera"**, when you mean the device. A device *has* a
  camera and may have it off.
- **Server is authoritative.** Scores, turn order and match state are computed on the server; the
  client renders. Client-supplied scores are recomputed, client-claimed identities are verified.
- **⏳-marked terms are aspirational.** Nothing carries the marker at present.

## Known vocabulary/code mismatches

Facts, listed so nobody has to rediscover them. (Mode-specific vocabulary sitting in mode-agnostic
layers has its own table [above](#mode-specific-vocabulary-in-mode-agnostic-layers).)

| Mismatch | Where |
| --- | --- |
| `set_player_name` is handled server-side, but `useMatch`'s `setPlayerName` is never returned, so no UI can send it | [`useMatch.ts`](../src/client/hooks/useMatch.ts) |
| "Leg" appears in comments and test names for what is currently a whole match | [`session.ts`](../src/server/scoring/session.ts), the e2e specs |
| `visitNumber` counts across the leg and both players, not per player | [`x01.ts`](../src/server/modes/x01.ts) |
| The visit history shows the current leg only; earlier legs are kept in `MatchState.legs` and are summarised, never replayed | [`MatchScreen.tsx`](../src/client/pages/MatchScreen.tsx) |
