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

Note what is absent: no match, no set, no leg number, no socket, no ids beyond the players. A mode
that cannot see the match structure cannot accidentally depend on it — which is why adding sets and
legs to the match needed no change to any mode at all. The match layer hands over the current leg's
visits and keeps the finished ones to itself.

**Why pure derivation.** Undo, reconnect, spectating and (later) starting a fresh leg all become
free: there is no second copy of the truth to keep in sync. x01 already worked this way for the
remaining score; the one exception — a `doubleInMet` map living on the handler instance, outside the
match state and never cleared — was exactly the thing that could not have survived a leg boundary.
It is derived now: *a player has satisfied double-in iff they have a committed non-void visit whose
darts contain a double.*

If a future mode genuinely cannot derive its state by replay, add an explicit opaque per-leg state
blob to `LegContext` — deliberately, and after establishing that replay really is impossible.

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

  /** The mode's own block of the match screen, across the whole match. Optional. */
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

- **`getRemainingScore`** — a countdown is an x01 concept. Nothing outside x01 needs it. (The camera
  layer used to; it now asks `isVisitLocked` instead, which is the mode-agnostic question it was
  really asking.)
- **Any way to end the match.** A mode reports `legWinnerId`; the match layer decides what that means
  for the set and the match. A mode never writes `status`, `winnerId`, `finishedAt` or
  `currentPlayerIndex`.
- **Turn advancement.** A visit is exactly one player's turn, and the board passes to the next
  player still in the match when the visit is submitted — round the roster, stepping over anyone who
  has left. That is universal, so the match layer does it.

### Locked ≠ ended

`isVisitLocked` means *"no further dart will be accepted in this visit"*. The visit stays open until
it is submitted — by the player pressing Submit, or by the camera layer seeing a
[takeout](./glossary.md#tip-throw-window-tracked-dart-takeout). That gap is deliberate: it is when a
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
which of its two panel renderings to use, or neither — only in a development build
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

**A ban is about a feature, not about media.** A mode that declined both would still declare its
tier, join the mesh, take a roster and show the "Setting up match…" overlay exactly as any other —
because `tier: 'disabled'` means *creates no peer identity*, which is a much larger thing, and
because whatever is added to the mesh later should reach a mode that never asked to opt out of it.

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
readonly maxPlayers?: number;   // Whac-A-Mole says 2; x01 and count-up say nothing
```

**It is a fact about the mode's rules, not a setting.** Whac-A-Mole declares 2 because its rules
were written for two players and have not been migrated; a mode written for any number simply leaves
it out, as x01 does — a leg of x01 is a race of independent remaining scores, with no rule that
reads one player's history while judging another's. Declaring a cap is not knowing that lobbies,
users or connections exist — the same discipline as `fields` and `bansMedia`.

**A mode narrows; it never widens.** The deployment's `server.maxPlayersPerMatch` (default 5) is the
ceiling, and `effectiveMaxPlayers(serverMax, modeMax)` in
[`shared/settings.ts`](../src/shared/settings.ts) is the smaller of the two. `describeMode` turns an
absent declaration into `null`, so no consumer has to tell "no limit" from "did not say", and both
sides of the wire ask through the same function — the lobby cannot offer a place the server would
refuse. It **fails open**: a mode this build does not have imposes nothing.

Because the cap is the mode's, it moves when the mode does. Switching a lobby to a mode that takes
fewer players than are already in it is **refused**, and the message names the mode:

> Whac-A-Mole takes at most 2 players

Refusing beats allowing it and blocking Start later — the person changing the mode is the person who
can undo it, and telling them then is the only moment that is true.

---

## The match screen

The screen is universal chrome. Every mode-specific value arrives in `ModeView`, computed on the
**server** and shipped with the match state, so the client holds no rules and a new mode needs no
client code — except an optional panel component (below).

```ts
interface ModeView {
  headline: ViewText;                     // x01: "501 — Double Out"
  notice?: ViewText;                      // x01: "Double-In required — hit a double to start scoring"
  playerScores: Record<string, ViewText>; // playerId → card score. Text, so it need not be a number
  visitTotal: ViewText;                   // empty text hides the line; x01 always returns a number
  dartsPerVisit: number;
  slots?: ViewText[];                     // optional slot contents; omitted → default rendering
  history: ViewText[];                    // newest first, one entry per committed visit
  panel?: unknown;                        // optional payload for the mode's own screen element
}
```

### Text, and what a mode may say about how it looks

Every piece of text above is a `ViewText`: either a bare string, or a string with hints.

```ts
type ViewText = string | { text: string; tone?: TextTone; size?: TextSize; weight?: TextWeight };

type TextTone = 'default' | 'muted' | 'accent' | 'positive' | 'warning' | 'danger';
type TextSize = 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';
type TextWeight = 'normal' | 'medium' | 'semibold' | 'bold';
```

Three rules make this a hint and not a stylesheet:

1. **Tones are meanings, not colours.** A mode says `danger`; what that looks like is decided once,
   in [`client/components/modeText.ts`](../src/client/components/modeText.ts). `danger` is red text
   in the history and a red-backed slot on the board — the same word, expressed the way each element
   expresses things. A redesign changes one file.
2. **Every hint is optional, and overrides exactly one axis.** Whatever a mode leaves out comes from
   the element's own defaults, which is what keeps the screen looking like one screen. A bare string
   is the normal case and should stay the normal case.
3. **The screen's own concerns win where they are not the mode's.** The player card colours whoever
   is throwing; a mode that says nothing about a score inherits that. x01 sends plain strings for
   scores and only speaks up for `Bust!` and `Checkout!`.

Why hints and not markup: the view is JSON on a WebSocket, and React elements do not survive
`JSON.stringify`. A mode that needs real markup has the [panel](#the-match-screen) for it.

Note what this buys beyond looks — **the screen stops inferring.** It used to decide a card score was
a verdict by testing whether the string was numeric, and colour a dart slot by checking whether the
dart scored above zero. Both were the screen guessing at x01's rules. Now x01 says so.

Top to bottom:

| # | Element | Universal | From the mode |
| --- | --- | --- | --- |
| 1 | Headline | the element, the spectator suffix | `headline`, `notice` |
| 2 | Player cards | names, standings (sets and legs), current-player highlight, "▶ throwing", winner banner | `playerScores[playerId]` |
| 3 | **Mode panel** | the slot | rendered entirely by the mode; nothing shown when `panel` is absent |
| 4 | Dartboard (manual input) | all of it | — |
| 5 | Visit slots | the element | `dartsPerVisit`, optionally `slots` |
| 6 | `Visit: <total>` | the element | `visitTotal` — an empty string hides the line |
| 7 | Undo / Submit Visit | all of it | — (they act on the current visit, which the mode interprets) |
| 8 | History | the element | `history` |
| 9 | Leave | all of it | — |

### A screen that does not jump

**An element should be its final size from the first frame, not the size of what it currently has to
show.** A match screen fills up as it is played — visits land in the history, a panel's numbers
appear once there is something to average — and anything that grows as that happens shoves whatever
is under it down the page, under the hand of someone who is aiming at a dartboard.

What this looks like in practice:

- **Reserve the rows.** The visit history draws a fixed number of rows from the start and leaves the
  ones it has nothing for blank ([`MatchScreen.tsx`](../src/client/pages/MatchScreen.tsx),
  `HISTORY_ROWS`). It is not scrolled to a maximum height; it is that height throughout.
- **Show the element before it has content.** x01's panel renders with `0` darts thrown and `—`
  for the averages rather than waiting for a first visit, which is why the board does not move when
  one is thrown.
- **Keep a slot's width off its contents.** Dart slots and score cards have a width from the layout,
  not from the label inside them, so `T20` and `miss` occupy the same space.
- **A breakpoint may change the size; content may not.** Fewer history rows on a phone than in a
  column of its own is fine. What must not happen is the same screen changing size under itself.

This is good practice rather than an enforced rule, and there are places that do not follow it yet.
Anything new on the match screen should.

### The summary

Once the match is finished the screen becomes **the match's**, not the mode's. The input block (4–7)
unmounts, the player cards show winner and loser instead of a score, and the history is replaced by
the match scoreline — legs per set, read like a tennis result.

A mode contributes exactly two things to it:

- the **headline**, so the summary still says what was played;
- the **panel**, which is the one place a mode may show its own statistics after a match. x01 uses
  it for nothing, so nothing is rendered there.

Everything else on the summary — the verdict, the scoreline, the re-match, Exit — is match-level and
means the same whatever was played. The re-match in particular is **not** a mode concern: it starts
an ordinary new match with the same settings and participants, and no mode is consulted.

This is also why a finished match needs no special handling on the mode side: its current leg is
empty, and there is nothing left for the mode to describe.

Notes:

- **Player card scores are strings**, not numbers. That is what lets x01 show `"Bust!"` or
  `"Checkout!"` in place of a score without the screen knowing what a bust is.
- **Slot contents default sensibly.** Without `slots`, the screen renders the dart's own label —
  `T20 (60)` — which is the right thing for most modes. A mode overrides it only if it needs to.
- **The mode panel** (element 3) is the mode's own block, described as data:

  ```ts
  interface ModePanel {
    title?: string;
    lines?: ViewText[];                                    // facts about the leg, not about a player
    rows: { label: string; values: Record<PlayerId, ViewText> }[];
    custom?: unknown;                                      // only if the mode ships a component too
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

`count-up` is installed in development builds and in the test runner, and **not in production**:
`registry.ts` imports it behind `IS_DEV`, the same switch that hides x01's `stats` field. Expect to
see it in the lobby under `npm run dev` and not on a deployed server.

It was added when x01 and Whac-A-Mole both capped themselves at two players
([Limiting the player count](#limiting-the-player-count)) and nothing could exercise a match of
three or more. x01 has since been let off its cap, so a deployed server can play five-handed
without it; what count-up still gives the test suite is a mode with **no rules to get in the way** —
every dart adds its face value, first to `targetScore` takes the leg, no busts and no finishing
rule. Keeping it out of production is what lets it stay that thin.

It is the one exception to "a mode is a file plus one line": the line is conditional. Anything else
about it is an ordinary mode.

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
    const visit: Visit = { playerId: ctx.currentPlayerId, darts, visitNumber: ctx.visits.length + 1, voided: false };
    const total = scored(ctx.visits, ctx.currentPlayerId) + points(darts);
    // A leg always ends with a winner. That guarantee is what the match layer is built on.
    return { visit, legWinnerId: total >= numberOr(ctx.settings, 'target', 200) ? ctx.currentPlayerId : null };
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
when the client is built ([`panels.ts`](../src/client/modes/panels.ts)) — and **replaces** the
generic table, receiving the whole panel: the same rows, plus whatever the mode put in `custom` for
its own use.

The two halves degrade into each other, which is the property to preserve when writing one:

| | with the file | without it |
| --- | --- | --- |
| the rows | drawn however the mode likes | a plain table |
| `custom` | drawn | ignored |

**Whac-A-Mole is the worked example of taking that further**
([`whac-a-mole.tsx`](../src/client/modes/whac-a-mole.tsx)). Its panel draws a heads-up display in the
slot it was given, and then portals two more surfaces: an overlay into the live dartboard's own
wrapper — mirroring its viewBox, so it follows the precision-aim zoom, and `pointer-events: none`, so
every click still reaches the board underneath — and a closing screen sized to exactly that same
square, which is what keeps the score cards and the Submit button it asks you to press uncovered.
Nothing in the match screen was changed to allow it; the board is found through
`[data-testid="dartboard"]`, which is recorded as a leak in the
[glossary's table](./glossary.md#mode-specific-vocabulary-in-mode-agnostic-layers). Delete the file
and the mode is still playable off its rows.

**x01 is the worked example of the ordinary case** ([`x01.tsx`](../src/client/modes/x01.tsx)). It
lays the same rows out per player rather than per statistic, highlights whoever leads each one — knowing that *fewer* darts
is better, which is the sort of thing only a mode can know — and draws recent visit scores as bars
from the `custom` payload, a shape a table has no way to express. Delete the file and the panel is a
table of the same six numbers; nothing is lost but the presentation.

That file is the *only* reason a mode is ever more than one file, and it needs a client build to take
effect, not just a restart.

Nothing else in the app should need to change. The standing check is

```
grep -rE 'startScore|doubleIn|doubleOut|bust' src
```

— outside `server/modes/x01.ts` that should return nothing but comments and dartboard geometry. If your mode forces a change elsewhere, that is a leak: record it in the
glossary's
[mode-specific vocabulary table](./glossary.md#mode-specific-vocabulary-in-mode-agnostic-layers)
rather than working around it quietly.
