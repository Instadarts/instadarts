# Game modes

How a game mode plugs into the app: what it owns, what it may look at, and what it contributes to
the match screen.

Read [the glossary](./glossary.md) first — this document uses its vocabulary precisely, in
particular **match**, **set**, **leg**, **visit** and **[x01]**.

---

## The three layers

| Layer | Owns | May **not** know |
| --- | --- | --- |
| **Match** | match / set / leg structure, participants, whose visit it is, leg → set → match progression, lifecycle, transport, persistence | any rule of any mode |
| **Game mode** | how one **leg** is played and won: darts → game events, when a visit is locked, when a visit is void, who won the leg, its own settings, its own display values | that sets, legs, sockets, lobbies or spectators exist |
| **Match screen** | universal chrome and layout | any rule of any mode; every mode-specific string comes from the mode |

Two rules follow from this and are worth stating on their own:

1. **A leg always ends with a winner.** A mode may not end "in a draw" or "run out". Match logic
   (first to *n* legs, first to *m* sets) is built on that guarantee and applies uniformly to every
   mode.
2. **A mode is the first and only authority on darts.** Wherever a dart comes from — the manual
   dartboard or the camera fusion layer handing over a scored dart — it reaches the mode, and only
   the mode decides what it means.

---

## Match format around the mode

A mode plays one **leg** and reports its winner. The match layer groups legs into sets according to
`legsToWinSet` and groups sets into the match according to `setsToWinMatch`. The current leg's visits
live in `MatchState.visits`; completed legs move to `MatchState.legs` with their winner. Standings
are derived from that ordered history by [`matchFormat.ts`](../src/shared/matchFormat.ts), not stored
separately.

The starting player advances by one roster position for every completed leg, continuing across set
boundaries. Within a leg, submitted visits advance to the next player who has not left the match.
The mode neither chooses the next player nor sees the match format.

When a match finishes, the summary is match-level: it shows the result, legs per set, and re-match
state. The mode contributes the headline only; its live panel is not mounted on the summary.

---

## What a mode may look at: `LegContext`

A mode is a set of **pure functions** over one leg. It holds no state of its own: everything is
derived from the visit history and the visit in progress.

```ts
interface LegContext {
  settings: ModeSettings;      // this mode's own settings, already validated
  players: Player[];
  currentPlayerId: string;
  visits: Visit[];             // committed visits of THIS leg, in order
  currentVisit?: CurrentVisit; // the visit in progress, if any
}
```

Note what is absent: no match, no set, no leg number, no socket, and no identifiers other than
player IDs. A mode cannot depend on match structure because it cannot see it. The match layer passes
the current leg's visits and retains the finished legs.

Pure derivation leaves no second state to synchronize during undo, reconnect, spectating, or a new
leg. For example, x01 derives double-in from whether a player has a committed non-void visit
containing a double.

---

## The contract

```ts
interface GameMode {
  readonly id: string;              // 'x01'
  readonly label: string;           // shown in the lobby's mode selector
  readonly defaults: ModeSettings;  // ─┐ its settings, declared here and nowhere else
  readonly fields: SettingsField[]; // ─┘

  /** The most players its rules take. Omitted means none of its own — see "Limiting the player count". */
  readonly maxPlayers?: number;

  /** Media features this mode does not want. Omitted means none — see "Declining a media feature". */
  readonly bansMedia?: readonly MediaFeature[];

  /** How many darts a visit may hold. The match screen and validation both read this. */
  dartsPerVisit(settings: ModeSettings): number;

  /** May the visit in progress take another dart? Evaluated after each dart. */
  isVisitLocked(ctx: LegContext): boolean;

  /** Finalize the visit in progress: the mode decides padding, voiding, and who won the leg. */
  finalizeVisit(ctx: LegContext): { visit: Visit; legWinnerId: string | null };

  /** Everything mode-specific the match screen displays for the current leg. */
  view(ctx: LegContext): ModeView;

  /** The mode's own live-screen block, derived across the whole match. Optional. */
  panel?(match: MatchState): ModePanel | undefined;
}
```

Note the asymmetry between the last two, which is the whole point of it:

| | sees | may return |
| --- | --- | --- |
| the rules and `view` | one `LegContext` | rules outcomes, and strings |
| `panel` | the whole `MatchState` | something to draw, and nothing else |

`panel` is handed everything precisely because it can only draw. A statistic is about the match, not
about a leg — an average read off a single leg would be a different number every time one ended — so
the function that computes it needs the match. And since nothing it returns reaches the rules, giving
it the match cannot make a mode's play depend on the format.

Deliberately **not** in the contract:

- **Any way to end the match.** A mode reports `legWinnerId`; the match layer decides what that means
  for the set and the match. A mode never writes `status`, `winnerId`, `finishedAt` or
  `currentPlayerIndex`.
- **Turn advancement.** A visit is exactly one player's turn, and the board passes to the next
  player still in the match when the visit is submitted — round the roster, stepping over anyone who
  has left. That is universal, so the match layer does it.

### Locked ≠ ended

`isVisitLocked` means *"no further dart will be accepted in this visit"*. The visit stays open until
it is submitted — by the player pressing Submit, or by the camera layer seeing a
[takeout](./vision.md#server-fusion-and-visit-tracking). That gap is deliberate: it is when a
misread third dart gets corrected.

x01 locks on: the visit is full, the score reached zero, or the visit is already bust.

---

## Settings

A mode **declares** its settings; it does not have them declared for it.

```ts
interface ModeDescriptor {
  id: string;
  label: string;                 // shown in the lobby
  defaults: ModeSettings;
  fields: SettingsField[];       // declarative, rendered generically
  bansMedia: readonly MediaFeature[];   // optional to declare, always present to read
  maxPlayers: number | null;            // likewise: `null` is "declared none" and "said nothing"
}

type SettingsField =
  | { key: string; label: string; kind: 'toggle' }
  | {
      key: string; label: string; kind: 'number';
      min: number; max: number;
      /** Usual values, offered as a dropdown. Suggestions — anything in range is still accepted. */
      options?: { value: number; label: string }[];
    }
  | {
      key: string; label: string; kind: 'select';
      /** The whole of what this setting may be. Unlike a number's options, nothing else is accepted. */
      options: { value: string; label: string }[];
    };
```

Declared by the mode itself, and used by both sides:

- the **lobby** renders the mode selector and the field list generically
  ([`MatchSettingsPanel`](../src/client/components/MatchSettingsPanel.tsx)) from the catalog the
  server sends on connect (`mode_catalog`) — the client imports no mode's code;
- the **server** validates incoming settings against the same field list
  ([`validateSettings`](../src/server/validation.ts)), reading only declared keys.

Validation returns a *complete* settings object, filling gaps from what the lobby already has. Only a
malformed payload or an unknown mode is rejected outright; a single value that fails its field's
rules is dropped and the current one kept, so one bad number cannot discard the rest of the form.
Switching mode starts from the new mode's defaults — the outgoing mode's values mean nothing to it.

`MatchSettings` is `{ mode, modeSettings, legsToWinSet, setsToWinMatch }` — the format sits next to
`mode`, never inside `modeSettings`, and is validated against `MATCH_FIELDS` by the same code that
validates a mode's own fields.

**A field may be conditional, and leaving it out is what hides it.** x01 offers its `stats` knob —
`graphic`, `text` or `off`, which it spends on [`ModePanel.render`](#the-optional-second-file) and on
returning no panel at all — only in a development build
(`IS_DEV` in [`server/env.ts`](../src/server/env.ts)). Because the lobby and the validator read the
same list, a field that is not declared is not merely absent from the form: it cannot be set at all,
so no crafted message reaches it. The **default** is unconditional, so the setting still exists and
production simply always has the value it defaults to. Hiding a field is therefore never the same as
removing a setting — the mode must still work when the field is not there.

---

## Declining a media feature

A mode may name [media](./media.md) features it does not want:

```ts
export type MediaFeature = 'boardVideo' | 'dartEvidence';

// whac-a-mole.ts — the moles are drawn onto the board's own geometry, and a photograph of a real
// board cannot be laid over them. Stills are a strip under the slots and are untouched.
bansMedia: ['boardVideo'],
```

Declared like `fields` and read elsewhere, so naming a feature is still not knowing that peers or
sockets exist. `describeMode` turns an absent declaration into an empty list, so a consumer never has
to tell "declined none" from "did not say", and both sides ask through `modeBans` in
[`shared/settings.ts`](../src/shared/settings.ts), which **fails open**: a descriptor that has not
arrived is not an instruction to withhold anything.

**A ban is about a feature, not about media.** Even if a mode bans both current features,
participants still declare their tiers, join the mesh, receive rosters, and show the "Setting up
match…" overlay. Disabling media entirely is a separate choice: `tier: 'disabled'` creates no peer
identity.

Where each ban bites, and why they differ:

| Feature | Enforced | Where |
| --- | --- | --- |
| `boardVideo` | on the **server** | `syncSource` in [`server/media.ts`](../src/server/media.ts) withholds the active `media_source_state`, so the camera never mints a feed id and never offers. The device keeps its place in every roster, which is what leaves stills, director commands and the owner's link working — refusing it in `planFor` instead would take all of those with it. The frontend also declines, which with the directive withheld is belt and braces. |
| `dartEvidence` | on the **client** | A still request is one peer asking another and never reaches the server, so there is nothing there to refuse. `useDartEvidence` takes an `enabled` option that gates the asking and the strip together. |

---

## Limiting the player count

The same shape as a media ban, for the same reason: a mode says one thing about itself, and
something else acts on it.

```ts
readonly maxPlayers?: number;   // no current mode declares one
```

**It is a fact about the mode's rules, not a setting.** A mode written for any number of players
simply leaves it out. Neither x01 nor Whac-A-Mole reads one player's history while judging another,
and no registered mode declares a cap. Declaring one is not knowing that lobbies, users or
connections exist — the same discipline as `fields` and `bansMedia`.

Tests register a capped mode to verify this optional part of the contract without depending on a
production mode.

**A mode narrows; it never widens.** The deployment's `server.maxPlayersPerMatch` (default 5) is the
ceiling, and `effectiveMaxPlayers(serverMax, modeMax)` in
[`shared/settings.ts`](../src/shared/settings.ts) is the smaller of the two. `describeMode` turns an
absent declaration into `null`, so no consumer has to tell "no limit" from "did not say", and both
sides of the wire ask through the same function — the lobby cannot offer a place the server would
refuse. It **fails open**: a mode this build does not have imposes nothing.

Because the cap is the mode's, it moves when the mode does. Switching a lobby to a mode that takes
fewer players than are already in it is **refused**, and the message names the mode:

> Two Only takes at most 2 players

Refusing beats allowing it and blocking Start later — the person changing the mode is the person who
can undo it, and telling them then is the only moment that is true.

---

## The match screen

The screen is universal chrome. Every mode-specific value arrives in `ModeView`, computed on the
**server** and shipped with the match state, so the client holds no rules and a new mode needs no
client code — except an optional panel component (below).

```ts
interface ModeView {
  headline: ViewText;                     // x01: "501 — Double Out"; one line, width-fitted
  notice?: ViewText;                      // x01: "Double-In required — hit a double to start scoring"
  playerScores: Record<string, ViewText>; // playerId → automatically fitted card score
  visitTotal: ViewText;                   // empty text hides the line; x01 always returns a number
  dartsPerVisit: number;
  slots?: ViewText[];                     // optional slot contents; omitted → default rendering
  history: ViewText[];                    // newest first; shown by the optional Visit history card
  autoSubmit?: boolean;                   // nothing to throw this turn; the screen moves it on
}
```

**`autoSubmit` is the one field that asks for an action** rather than describing something to draw.
A mode sets it for a turn that has nothing in it — Whac-A-Mole does when a player's darts are all
down the burrow — and the screen submits that visit for them instead of waiting on a button nobody
has a reason to press. Only the client holding that player acts on it, and the screen owns the
pacing: it holds the turn on screen briefly first, so a skipped turn reads as a turn rather than as
a dropped frame.

Be careful with it, because *not throwing* and *nothing to wait for* are different states. A closing
screen the mode wants read is also a visit with no darts in it; setting `autoSubmit` on one would
sweep it away before anybody saw it. Whac-A-Mole's curtain call is exactly that case, and its flag
is written `!over && allowance === 0` for that reason.

The overview keeps `headline` on one line and measures it into the width left by the spectator
badge, when there is one, and the **Leave** button. Its tone hint is honoured, while its font size and
weight belong to the overview.
Keep the text concise: the fitter retains a readable minimum rather than shrinking an arbitrarily
long headline into illegibility.

### Text, and what a mode may say about how it looks

Mode-supplied display text is a `ViewText`: either a bare string, or text with a semantic tone.

```ts
type ViewText = string | { text: string; tone?: TextTone };

type TextTone = 'default' | 'muted' | 'accent' | 'positive' | 'warning' | 'danger';
```

Three rules keep this a semantic hint rather than a stylesheet:

1. **Tones are meanings, not colours.** A mode says `danger`; what that looks like is decided once,
   in [`client/components/modeText.ts`](../src/client/components/modeText.ts). `danger` is red text
   in ordinary mode text and a red-backed slot in the visit card — the same word, expressed the way
   each element expresses things. A redesign changes one file.
2. **A tone is optional.** A bare string inherits the element's contextual tone and should remain
   the normal case. For example, the player card colours whoever is throwing unless the mode needs
   to say that a score is a `danger` or `warning`.
3. **Geometry belongs to the screen.** Modes cannot hint font size or weight. Each element owns
   those choices, including responsive fitting: player cards fit scores in both axes and the
   overview fits its headline in the available width. x01 therefore sends plain strings for scores
   and only speaks up with tones for `Bust!` and `Checkout!`.

A mode that wants more than a colour can have it, without the shared components learning anything
about the mode. `VisitInput` reflects each slot's tone as `data-slot-tone`, so a mode's own
stylesheet can select on what it said. Whac-A-Mole uses this for its bonus throw: `warning` is the
one tone nothing else in its slot row sends, so `[data-visit-slots] > div:last-child[data-slot-tone="warning"]`
is unambiguously "the bonus is live", and the pulsing ring that draws it lives in
[`client/modes/whac-a-mole.tsx`](../src/client/modes/whac-a-mole.tsx) where the rest of that mode's
presentation lives. Note what this depends on: a tone used as a flag must actually be unique within
that row, and it is the mode's job to keep it so.

Why hints and not markup: the view is JSON on a WebSocket, and React elements do not survive
`JSON.stringify`. A mode that needs real markup can provide an
[optional client component](#the-optional-second-file).

The screen does not infer mode meaning from text or score values. A mode supplies the relevant
semantic tone explicitly.

The page-level boxes are arranged by the responsive match grid rather than a fixed DOM order:

| # | Element | Universal | From the mode |
| --- | --- | --- | --- |
| 1 | Overview | the element, the spectator badge, Leave | `headline` |
| 2 | Player cards | names, standings (sets and legs), current-player highlight, "▶ throwing", winner banner | `playerScores[playerId]` |
| 3 | Dartboard | manual input and optional live-board presentation | — |
| 4 | Visit | slots, evidence, Undo / Submit | `notice` in the card header, `dartsPerVisit`, optional `slots`, `visitTotal` |
| 5 | **Mode panel** | the responsive box | rendered from `panel`; nothing shown when `panel` is absent |
| 6 | Visit history | optional live card, disabled by default at every breakpoint | `history`, newest first |

Every match-card title bar is user-hideable at each responsive breakpoint. A mode must therefore
treat `notice` and `panel.title` as supplemental presentation, never as the only place for
information or a control required to play. Whac-A-Mole satisfies this:
removing its mode-panel title loses no rules or state, all of which remain in the overview and the
panel's own HUD.

### A screen that does not jump

**An element should be its final size from the first frame, not the size of what it currently has to
show.** A match screen fills up as it is played — scores change and a panel's numbers appear once
there is something to average — and anything that grows as that happens could move the dartboard
under the hand of someone who is aiming at it.

What this looks like in practice:

- **Fix match-box geometry.** Live and summary boxes have canonical RGL heights at every stock
  breakpoint. Their bodies scroll internally when necessary; changing content does not remeasure a
  match box or move its neighbours.
- **Show the element before it has content.** x01's panel renders with `0` darts thrown and `—`
  for the averages rather than waiting for a first visit, which is why the board does not move when
  one is thrown.
- **Keep a slot's width off its contents.** Dart slots and score cards have a width from the layout,
  not from the label inside them, so `T20` and `miss` occupy the same space. Player score text fits
  itself inside the available card area instead of asking the mode for a font size.
- **A breakpoint or explicit layout edit may change the size; content may not.** What must not
  happen is the same match layout changing under itself because a score or statistic changed.

Preserve these constraints when adding match-screen content.

### The summary

Once the match is finished the screen becomes **the match's**, not the mode's. The board, visit and
mode-panel boxes unmount; result cards show winner and loser instead of a score, and match history
shows the scoreline — legs per set, read like a tennis result. The re-match box is left out for a
spectator and for a match somebody has left; result and match history are always there.

A mode contributes exactly one thing to the current summary:

- the **headline**, so the summary still says what was played.

Everything else on the summary — the verdict, the scoreline, the re-match, Exit — is match-level and
means the same whatever was played. The re-match in particular is **not** a mode concern: it starts
an ordinary new match with the same settings and participants, and no mode is consulted.

The summary has its own `match-summary` RGL profile, distinct from the live screen's `match-live`
profile. That presentation state does not widen the game-mode contract.

This is also why a finished match needs no special handling on the mode side: its current leg is
empty, and there is nothing left for the mode to describe.

Notes:

- **Player card scores are text**, not numbers. That is what lets x01 show `"Bust!"` or
  `"Checkout!"` in place of a score without the screen knowing what a bust is. A mode may attach a
  semantic tone, while the card automatically chooses the largest font that fits in both axes.
- **Slot contents default sensibly.** Without `slots`, the screen renders the dart's own label —
  `T20 (60)` — which is the right thing for most modes. A mode overrides it only if it needs to.
- **The mode panel** (element 5) is the mode's own block, described as data:

  ```ts
  interface ModePanel {
    title?: string;
    lines?: ViewText[];                                    // facts about the leg, not about a player
    rows: { label: string; values: Record<PlayerId, ViewText> }[];
    custom?: unknown;                                      // only if the mode ships a component too
    render?: 'auto' | 'table';                             // 'table' asks for the rows even where a component exists
  }
  ```

  Rendered generically, so a mode showing statistics needs no client code at all. x01 reports the
  round, darts this leg, a three-dart average, a scoring average, 180s, best leg and legs won — some
  about the current leg, some across every leg, which is why `panel` takes the match. The current-leg
  rows disappear on the summary, where there is no leg in progress to describe.

  A mode may also **draw its own panel**, and x01 does — see below.

---

## Installing and removing a game mode

**A mode is a file, plus one line.** Write `src/server/modes/<id>.ts` exporting a `GameMode` — its
rules, its settings and its panel together — call `registerMode(<id>)` at the top level of it, and
add `import './<id>.js';` to [`registry.ts`](../src/server/modes/registry.ts). Removing a mode is
the same two steps backwards.

`registry.ts` is the whole inventory: what the server ships with is a fact of the source, decided
when it is built, rather than of whatever files a deployment happens to have on disk.

Two consequences worth knowing:

- **A mode nobody imported is simply absent.** Nothing scans, so a file in the directory that
  `registry.ts` does not name is dead source — it never registers, and the server starts happily
  without it. The symptom is a mode missing from the lobby, not an error at boot.
- **x01 is mandatory.** It is the default a new lobby starts on, and `loadModes` refuses to start a
  server that does not have it registered.

### The development-only mode

`count-up` is registered only in development and tests through the `IS_DEV` branch in `registry.ts`;
production registers x01 and Whac-A-Mole.

### Writing one

Four methods are required and everything else is optional. A whole mode, small enough to read:

```ts
import type { ModeView, Visit } from '../../shared/types';
import { numberOr } from '../../shared/settings';
import type { FinalizedVisit, GameMode, LegContext } from './types';
import { registerMode } from './types';

export const highscore: GameMode = {
  id: 'highscore',
  label: 'Highscore',

  // Declared once: the lobby renders the field and the server validates against the same list.
  defaults: { target: 200 },
  fields: [{ key: 'target', label: 'Target', kind: 'number', min: 50, max: 900 }],

  dartsPerVisit: () => 3,
  isVisitLocked: () => false,

  finalizeVisit(ctx: LegContext): FinalizedVisit {
    const darts = ctx.currentVisit?.darts ?? [];
    const visit: Visit = {
      playerId: ctx.currentPlayerId,
      darts,
      visitNumber: ctx.visits.length + 1,
      voided: false,
    };
    const total = scored(ctx.visits, ctx.currentPlayerId) + points(darts);
    // A leg always ends with a winner. That guarantee is what the match layer is built on.
    return {
      visit,
      legWinnerId: total >= numberOr(ctx.settings, 'target', 200)
        ? ctx.currentPlayerId
        : null,
    };
  },

  view(ctx: LegContext): ModeView { /* headline, playerScores, visitTotal, dartsPerVisit, history */ },
};

registerMode(highscore);
```

What is *not* in there is the point of the layering. No match, set or leg number; no sockets,
lobbies or spectators; no state of its own — a mode is handed a `LegContext` and derives everything
from it, which is what makes undo, reconnect and starting the next leg free. This file, one import
in `registry.ts` and a restart is the whole installation: no client code, no route.

Things that catch people:

- **Settings arrive as an untyped bag.** Use `numberOr` / `boolOr` / `stringOr` from
  [`shared/settings.ts`](../src/shared/settings.ts) rather than writing the type check per setting.
  The fallback is not a second copy of the default — it is what to do with a settings object that
  did not come from a lobby.
- **Padding a visit is the mode's decision.** x01 pads a short visit out to three darts, because a
  turn costs three however few were aimed; a mode where that is untrue simply does not.
- **`view` is computed on the server and shipped.** It may hold text and styling hints, never
  markup — it has to survive `JSON.stringify`.
- **A `panel` is optional, and so is the client file that draws it.** Both halves degrade: no panel
  method draws nothing, no client file draws a plain table.

### The optional second file

A mode may add `src/client/modes/<id>.tsx`, exporting a component as default. It is picked up by
filename — no registry to edit on this half, since Vite's `import.meta.glob` resolves the directory
when the client is built ([`panels.ts`](../src/client/modes/panels.ts)) — and by default **replaces**
the generic table, receiving the whole panel: the same rows, plus whatever the mode put in `custom`
for its own use.

The two halves degrade into each other, which is the property to preserve when writing one:

| | with the file | without it |
| --- | --- | --- |
| the rows | drawn however the mode likes | a plain table |
| `custom` | drawn | ignored |

**`ModePanel.render` is how a mode asks for the table anyway.** `auto`, the default, is what the
table above describes: the component where the deployment has one, the table where it does not. `'table'` asks for
the table at both ends, which is what x01's development-only `stats: 'text'` selects. It is a
preference rather than an instruction, because the server half of a mode cannot see whether its
client half was built in — so `auto` can only ever promise the component where there is one to use.

**Whac-A-Mole is the worked example of taking that further**
([`whac-a-mole.tsx`](../src/client/modes/whac-a-mole.tsx)). Its panel draws a heads-up display in the
slot it was given, and then portals two more surfaces: an overlay into the live dartboard's own
wrapper — mirroring its viewBox, so it follows the
[precision-aim zoom](./ui.md#precision-aiming), and `pointer-events: none`, so
every click still reaches the board underneath — and a closing screen sized to exactly that same
square, which is what keeps the score cards and the Submit button it asks you to press uncovered.
It finds the board through `[data-testid="dartboard"]`, which is the current integration limit for a
mode drawing outside its panel. Without the client file, the mode remains playable through its
generic rows.

**x01 is the worked example of the ordinary case** ([`x01.tsx`](../src/client/modes/x01.tsx)). It
lays the same rows out per player rather than per statistic, highlights whoever leads each one —
knowing that *fewer* darts is better, which is the sort of thing only a mode can know — and draws
recent visit scores as bars from the `custom` payload, a shape a table has no way to express. Delete
the file and the panel falls back to a table of the same six numbers; only the presentation changes.

That file is the *only* reason a mode is ever more than one file, and it needs a client build to take
effect, not just a restart.

Nothing else in the app should need to change. Search `src/` for `startScore`, `doubleIn`,
`doubleOut`, and `bust`; outside `server/modes/x01.ts`, results should be limited to comments and
dartboard geometry. If a mode requires a change in a generic layer, document that boundary here
rather than working around it quietly.
