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

---

## Match structure

### User

A **user** is one frontend instance — practically, one browser tab running the gaming app. There
are no accounts, no logins and no persistent identity.

A user is identified by its **session id**: `crypto.randomUUID()`, minted by the server for every
WebSocket connection ([`src/server/index.ts:71`](../src/server/index.ts#L71)) and pushed to the
client in the non-`ServerMessage` `connected` frame. Server-side, the per-connection record is
`Client` ([`src/server/types.ts`](../src/server/types.ts)).

Consequences worth knowing:

- A session id is **per connection, not per user**. A page reload produces a new one; the `reconnect`
  message re-binds the existing player to it by overwriting `player.sessionId`.
- Ownership checks ("only your own player", "only the creator may change settings") compare
  `client.sessionId` against `lobby.hostSessionId` / `player.sessionId`.
- Browser-level state that outlives the tab (paired scoring devices) lives in `localStorage`;
  tab-level state (which devices *this tab* is using) lives in `sessionStorage`. See
  [`deviceStorage.ts`](../src/client/lib/deviceStorage.ts).

Do **not** write "user" when you mean a player. In a local match one user owns two players.

### Player / Participant

A **player** is a participant in a match. Prefer **player** in code and UI; *participant* is
acceptable in prose when contrasting with users, but no identifier should use it.

```ts
interface Player { id: string; name: string; sessionId: string }
```

- Player ids are `p1`, `p2`, … from a process-global counter
  ([`src/server/player.ts`](../src/server/player.ts)) — unique per server run, not per match.
- Every player carries the `sessionId` of the user who added it. In a **local** match both players
  carry the same session id; in an **online** match one player belongs to each user.
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
  players and settings into the new match ([`store.ts:92`](../src/server/store.ts#L92)).
- Idle lobbies are garbage-collected after 10 minutes ([`gc.ts`](../src/server/gc.ts)).

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
("Only the match creator can change settings"). `isCreator` in the client is
`sessionId === lobby.hostSessionId || lobby.isLocal`. `hostPlayerId` is separate and only set for
online lobbies — the first player the host adds.

Pick one word in new code: **host** for the server-side session, **creator** in user-facing copy.

### Spectator

A read-only observer. A user becomes one via `spectate` on `/spectate/:id`, which sets
`client.isSpectator` and binds it to a lobby or match without adding a player. Spectators are
excluded from every gameplay guard, and explicitly from scoring: a spectator with a paired camera
must not score ([`resolveScoringTarget`](../src/server/wsHandler.ts#L759)).

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

- they cannot reconnect to it (`reconnect` is refused with "You have left this match");
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
score ([`validateDartThrow`](../src/server/validation.ts#L73)). A dart is its position; the number is
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

How one [leg](#leg) is played and won, plus the settings those rules need. Currently one exists:
**x01**. Full contract in [game-modes.md](./game-modes.md).

- The rules are `GameMode` in [`server/modes/types.ts`](../src/server/modes/types.ts):
  `dartsPerVisit`, `isVisitLocked`, `finalizeVisit`, `view`. Modes register themselves at boot and
  are looked up by `settings.mode`.
- A mode is **pure functions over a [`LegContext`](../src/server/modes/types.ts)** — settings,
  players, whose visit it is, the committed visits and the visit in progress. It holds no state:
  anything it needs, it derives from the visit history.
- A mode declares its own settings — label, defaults and fields — in its own file, and the server
  sends that catalog to the client on connect (`mode_catalog`). Both the lobby panel and the server
  validator read the same declaration; the client imports no mode code.
- **A mode is a file.** `src/server/modes/<id>.ts` is found by scanning the directory at boot, so a
  deployment installs or removes one by adding or deleting a file. x01 is mandatory: the server
  refuses to start without it.
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
| Three darts per visit is assumed by the client's fixed-width slot row, though the count itself comes from `view.dartsPerVisit` | [`VisitInput.tsx`](../src/client/components/VisitInput.tsx) | Layout, not logic: the row is sized for three and would need rethinking for a mode that wants five |

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
the distinctions are load-bearing, so keep them apart in prose too.

### Tip, throw window, tracked dart, takeout

- **Tip** (`BoardTip`) — one observation of a dart tip in board coordinates, already projected by the
  device. Devices send tips, never scores.
- **Throw window** — the short server-side window in which reports from several cameras about the
  *same* throw are fused into one set of darts ([`throwWindow.ts`](../src/server/scoring/throwWindow.ts)).
- **Tracked dart** — a dart the fusion layer believes is currently stuck in the board; this is what
  stops a dart from being counted again on the next frame ([`tracker.ts`](../src/server/scoring/tracker.ts)).
- **Takeout** — the player pulling the darts out, signalled by an **empty tip array** from every
  active camera. An empty array is meaningful, never a no-op; a malformed report is dropped whole so
  it can never be mistaken for one. Takeout is what submits a visit automatically — a full visit does
  not, deliberately. How many darts must be in the board before a takeout is believed is decided by
  `armThreshold`, which is where x01's bust rules currently leak into this layer.
- **Scoring session** — the per-(match, owning player) object that owns the throw window and tracker
  ([`scoring/session.ts`](../src/server/scoring/session.ts), keyed in
  [`scoring/store.ts`](../src/server/scoring/store.ts)).

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
| "Leg" appears in comments and test names for what is currently a whole match | [`session.ts`](../src/server/scoring/session.ts), `tests/e2e/app.spec.ts` |
| `visitNumber` counts across the leg and both players, not per player | [`x01.ts`](../src/server/modes/x01.ts) |
| The visit history shows the current leg only; earlier legs are kept in `MatchState.legs` and are summarised, never replayed | [`MatchScreen.tsx`](../src/client/pages/MatchScreen.tsx) |
