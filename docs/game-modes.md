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
- **Turn advancement.** A visit is exactly one player's turn, and the board passes to the other
  player when the visit is submitted. That is universal, so the match layer does it.

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
}

type SettingsField =
  | { key: string; label: string; kind: 'toggle' }
  | {
      key: string; label: string; kind: 'number';
      min: number; max: number;
      /** Usual values, offered as a dropdown. Suggestions — anything in range is still accepted. */
      options?: { value: number; label: string }[];
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

**A mode is a file.** Write `src/server/modes/<id>.ts` exporting a `GameMode` — its rules, its
settings and its panel together — and it is found at boot by scanning that directory. There is no
registry to edit, in either direction: deleting the file removes the mode.

Two consequences worth knowing:

- **A file in there that does not export a mode stops the server.** A half-installed mode is worth
  hearing about at boot rather than at the first dart.
- **x01 is mandatory.** It is the default a new lobby starts on, and the server refuses to start
  without it.

### The optional second file

A mode may add `src/client/modes/<id>.tsx`, exporting a component as default. It is picked up by
filename — again with no registry to edit — and **replaces** the generic table, receiving the whole
panel: the same rows, plus whatever the mode put in `custom` for its own use.

The two halves degrade into each other, which is the property to preserve when writing one:

| | with the file | without it |
| --- | --- | --- |
| the rows | drawn however the mode likes | a plain table |
| `custom` | drawn | ignored |

**x01 is the worked example** ([`x01.tsx`](../src/client/modes/x01.tsx)). It lays the same rows out
per player rather than per statistic, highlights whoever leads each one — knowing that *fewer* darts
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
