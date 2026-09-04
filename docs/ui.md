# User-interface architecture

The gaming frontend and the scoring-device app share one visual language, but they do not share one
layout system. Mantine is the design system for both. React Grid Layout (RGL) arranges the gaming
frontend's page-level boxes; the scorer remains a static, centred column because its camera geometry
must not be negotiated by a dashboard grid.

Read [game-modes.md](./game-modes.md) before changing what a mode contributes to the match screen,
and [vision.md](./vision.md) before changing any scorer camera surface.

## The two applications

[`main.tsx`](../src/client/main.tsx) chooses the application from the path before React mounts it and
marks the document with `data-app="frontend"` or `data-app="scorer"`. Both applications receive the
same [`MantineProvider`](../src/client/layout/appTheme.ts), theme, palette, card surface, icons,
wordmark and fullscreen control. Neither is pinned to a colour scheme: each reads its own remembered
one, described under [Appearance](#appearance) below.

They deliberately diverge after that:

| | Gaming frontend | Scoring device |
| --- | --- | --- |
| Entry component | `App` inside `BrowserRouter` | `ScorerApp` |
| React Strict Mode | yes | no: a development double mount would duplicate camera/runtime ownership |
| Page layout | RGL `Responsive` grids | static `AppShell` and a centred 28 rem column |
| Layout editing | live and finished match screens | none |
| Presentation zoom | one frontend preference | a separate scorer preference |
| Appearance | one frontend preference | a separate scorer preference |
| Socket and state | match/lobby state | scorer projection and vision runtime |

The scorer is a sibling application, not a route rendered inside `App`. Do not move it under the
frontend router or layout-editor provider. Links between the applications use plain anchors and
cause a page load. The home page's scoring-device link is the one grid item rendered without a card,
since it navigates to the scorer rather than offering an action on the current page.

## Design-system ownership

Use Mantine for routine interface work: typography, spacing, cards, stacks, groups, forms, buttons,
menus, dialogs, alerts, scrolling and repeated inner layouts. In particular,
`SimpleGrid minColWidth` is the normal answer when equally shaped content inside a box must wrap.
It does not require an application breakpoint.

[`AppCard`](../src/client/components/AppCard.tsx) is the common surface. It owns the card border,
header, optional centred header content, badge/actions area and body — including the header's own
background, which is what gives every box a title bar rather than bold text at the top of a
rectangle. A scorer or overlay can use it directly.
[`GridBox`](../src/client/layout/GridBox.tsx) adds the RGL fill classes and the match edit handle; it
is not a general card replacement outside an RGL item.
[`Wordmark`](../src/client/components/Wordmark.tsx) is the other shared surface: the mark, the name
and its treatment, in the one place they are decided. [`mark.svg`](../src/client/components/mark.svg)
is the canonical drawing. `Wordmark` inlines it so `currentColor` follows the surrounding theme;
the favicon plugin in [`vite.config.ts`](../vite.config.ts) generates the tab icon from the same
shapes.

The mark and name scale together from one font size. `Wordmark` uses
[`AutoFitText`](../src/client/components/AutoFitText.tsx) when `fitTo` is set; the containing box must
have a width independent of the fitted content. Check changes at the smallest header and
screensaver sizes, not only in a large preview.

Do not put RGL inside a box. The outer grid decides which boxes share a row; Mantine primitives
decide how the contents of one box flow. Keeping that boundary makes a box reusable and prevents a
page layout from leaking into its contents.

There is no utility-CSS framework in this repository. Prefer a Mantine prop or component before
adding CSS. Use [`index.css`](../src/client/index.css) for document-level rules, RGL integration,
shared geometry, presentation-zoom variables and reusable keyframe helpers. It contains no literal
interface colours; rules that paint interface chrome use the palette tokens described below. Do not
rebuild ordinary component or responsive layouts there.

Mode-specific animation styles stay with the mode and include a `prefers-reduced-motion` behavior.
A mode may style contributed content through semantic data attributes exposed by a generic
component. Keep the selector in the mode and do not make the generic component aware of that mode.

## Theming

[`palette.ts`](../src/client/layout/palette.ts) holds an `AppPalette`: the Mantine colour tuples, the
`white`/`black` pair, and one record of semantic tokens per colour scheme.
[`appTheme.ts`](../src/client/layout/appTheme.ts) applies it. Change application colours in the
palette rather than in components.

The palette has two layers:

**Mantine tuples** provide named shades such as `dark.8`, `gray.6` and `yellow`. `theme.white` and
`theme.black` also determine Mantine's body and text colours. Use these values for fixed artwork or
when a component specifically needs a shade.

**Semantic tokens** describe interface roles that differ between bright and dark schemes. They use
the `--instadarts-` prefix and cover application backgrounds, surfaces, borders, editing states,
accents, hints, shadows and the text tones defined by
[`modeText.ts`](../src/client/components/modeText.ts). `appCssVariables` exposes them through
Mantine's `cssVariablesResolver`. Add a token when a role is shared by components or needs a
different value between schemes.

### Surface and text contrast

[`palette.test.ts`](../tests/unit/palette.test.ts) enforces these minimums in both schemes:

| Pair | Minimum |
| --- | ---: |
| a surface against the one it sits on (`app-bg` → `surface`, `surface` → `surface-raised`/`-sunken`) | ΔL* 6 |
| `surface` → `surface-header`, which is meant to be felt rather than seen | ΔL* 4 |
| `surface` → `border`, a thin shape and so a bigger step | ΔL* 12 |
| a surface → the text drawn on it | contrast 7.0 |
| a surface → `tone-muted-fg`, `accent` or `link` on it | contrast 4.5 / 3.5 |
| each `tone-*-fg` → its own `tone-*-bg` | contrast 4.5 |

L* measures whether adjacent surfaces remain visibly separate in either scheme. WCAG contrast
measures whether text remains readable against its background.

### Chrome is themed. Artwork is not.

Interface surfaces and controls follow semantic palette tokens. Represented objects—including the
dartboard, darts, QR codes, camera overlays and game artwork—keep fixed colours across schemes. QR
codes also retain a white quiet zone. Exact-colour assertions in `match.spec.ts` and
`scorer-screensaver.spec.ts` protect this boundary.

### Appearance

Bright or dark appearance is remembered independently for the frontend and scorer.
[`appColorScheme.ts`](../src/client/layout/appColorScheme.ts) provides guarded storage and the
`MantineColorSchemeManager` used by `MantineProvider`. The default is dark, `auto` is not offered,
and storage remains empty until the control is used.

An inline script in [`index.html`](../src/client/index.html) applies the stored scheme before the
first paint. The provider owns it after the application mounts.

Both settings menus render
[`AppearanceControl`](../src/client/components/AppearanceControl.tsx) directly above presentation
zoom. It uses the nearest provider, shows the active scheme, and labels the action that pressing it
will perform.

## Frontend page grids

[`ResponsiveBoxGrid`](../src/client/layout/ResponsiveBoxGrid.tsx) is the one page-grid entry point.
It measures its container with RGL's `useContainerWidth` and uses RGL's stock responsive map:

| Breakpoint | Minimum container width | Columns |
| --- | ---: | ---: |
| `lg` | 1200 px | 12 |
| `md` | 996 px | 10 |
| `sm` | 768 px | 6 |
| `xs` | 480 px | 4 |
| `xxs` | 0 px | 2 |

These are **container widths**, not promises about `window.innerWidth`. Browser chrome, application
zoom and any containing layout can change the width RGL measures. Use the active breakpoint badge
in the match settings menu or measure the grid host when debugging; do not add a CSS media query to
force the result.

Every grid uses an 8 px row height, 12 px gaps and 12 px container padding. Canonical page layouts
live in [`frontendLayout.ts`](../src/client/layout/frontendLayout.ts), not in page components:

- home and join are centred stacks generated for every stock column count;
- the lobby is generated as balanced, centred rows, with at most two ordinary cards per row;
- live matches declare a tuned layout for each breakpoint;
- match summaries declare another tuned layout for each breakpoint.

A card whose inner layout genuinely depends on its RGL width can read `widthUnits` from
[`GridItemLayoutContext`](../src/client/layout/GridItemLayoutContext.tsx). This is different from a
pixel-width container query: four grid columns have different physical widths at different
breakpoints. The value follows the active breakpoint and the snapped width of an in-progress resize;
the persisted layout catches up when the resize is released. Whac-A-Mole uses four units as the point
where its score and player list can sit beside one another.

`ResponsiveBoxGrid` can materialise a missing smaller layout with RGL's own responsive generation,
but all current canonical page maps are complete. Prefer generated helpers when a rule really is the
same at every width; use explicit per-breakpoint match layouts when board usability needs deliberate
geometry. Do not copy layout constants back into page components.

### Document grids and match grids are intentionally different

Home, join and lobby are document-style grids. They are always static, prevent overlap, and compact
vertically. Items marked `autoHeight` are measured from their natural card contents — or, for an
item rendered without a card at all, from its own content box: home's scoring-device link is the one
such item today. A
`ResizeObserver` catches geometry changes and a `MutationObserver` catches content changes that a
flexed border box can hide; the resulting height is rounded up to whole RGL rows. Conditional lobby
boxes are removed from the item set and compaction closes the hole.

Match grids use fixed-height boxes with internally scrolling bodies. A changing score, visit or
statistic must not move the board under a player's hand. They are built with
`getCompactor('vertical', true, false)` — overlap allowed, collision prevention off — and RGL's
overlap-allowing compactor **does not compact at all**: its pass returns the layout untouched. During
a drag, an overlap is accepted rather than resolved by moving either box. That is deliberate: a box
does not push the rest of a carefully tuned match layout away, and gaps or overlap are available to
the person making the layout. Canonical layouts should still begin non-overlapping.

The Visit box also uses that fixed height internally: dart slots stay at the top, the visit score
and actions stay at the foot, and the space between them flexes. When dart evidence is available,
each square grows within that middle space until either its height or its matching slot-column width
becomes the limit, and remains centred under that slot. If the box is shorter than its minimum
content, its body scrolls with both the slots and footer reachable.

A match grid can drop a box too — the summary omits its re-match box for a spectator and for a match
somebody has left — and because nothing compacts, every remaining box keeps the position it was
given. The re-match box is the trailing summary item, so removing it shortens the grid at the result
and history row rather than leaving a visible hole. Removing an interior item from another match
layout can leave a gap, which is consistent with its free-placement behavior.

Constraints such as `minW`, `minH`, `static` and `isBounded` belong to each canonical layout item.
Restoring a saved position reapplies these declarations; constraints are not loaded from storage.

## The dartboard, and aiming at it with a finger

[`Dartboard`](../src/client/components/Dartboard.tsx) is the manual input surface: a pointer press
places a dart where it landed. What it produces is a board coordinate and nothing else, scored by
the server exactly as a camera's tip is — the board is one of the two ways a dart arrives, not a
second kind of dart.

Its two coordinate systems, and why drawn labels are sized in SVG units, are in
[development.md](./development.md#two-things-about-the-board-that-are-easy-to-get-wrong).

### Precision aiming

A bed is about 10 mm wide and a fingertip is not, so a press held for `HOLD_TO_AIM_MS` enters
**precision aiming**: the board's viewBox narrows by `PRECISION_ZOOM`, and the dart being placed is
drawn by [`PrecisionDart`](../src/client/components/PrecisionDart.tsx) with its needle on the exact
coordinate that will be scored. Release places that coordinate. Both constants, and the reasoning
for their values, are in
[`dartboardPrecision.ts`](../src/client/components/dartboardPrecision.ts).

Four properties are worth knowing before changing any of it:

- **The tip sits at a fixed physical offset from the finger**, down and to the right, because the
  point being aimed at is otherwise under the fingertip choosing it. That offset is measured in
  screen pixels rather than board units, so it is the same distance however large the board is
  drawn.
- **It is honoured against the visible board, then against the board's own edge.** The desired
  position is first kept inside the intersection of the SVG and the mobile visual viewport, inset so
  the tip is never flush against an edge; the viewBox is then clamped to the 0–100 square. That
  second clamp is the only remaining reason the offset can contract, and it does so only near an
  outer coordinate edge.
- **Dragging moves the tip with the finger, over less board.** The displacement is measured at
  precision scale, so the tip tracks the finger one-for-one *on screen* — which is what holds the
  offset steady for the whole drag — while covering `1 / PRECISION_ZOOM` as much board as the same
  movement would without the zoom. That is the whole mechanic: the same hand movement, finer board
  resolution. It is measured from where the hold began rather than accumulated frame by frame, and
  the tip is clamped to the zoomed window, so dragging past its edge stops the tip rather than
  panning.
- **A gesture that can no longer land is cancelled, not completed.** A turn can lock remotely while
  a finger is still down, and the board drops the held gesture when `canPlaceDart` goes false rather
  than placing a dart the server would refuse.

The board hides its cursor during a hold, and a `VisuallyHidden` `role="status"` region announces
the segment currently under the tip, since the value being chosen changes without anything being
committed.

Precision aiming changes the viewBox on the live board, which is why a mode drawing an overlay onto
it has to mirror that attribute rather than assume `0 0 100 100` — see
[the optional second file](./game-modes.md#the-optional-second-file).

Nothing here reaches the server: the dart submitted is the same `DartThrow` a plain tap produces, so
a test that only needs *a* dart should tap. `match.spec.ts` covers the mechanic through
`data-testid="precision-dart"` (carrying `data-score`, `data-board-x`/`-y` and `data-flight-color`)
and `data-testid="precision-status"`. Assert offsets and distances through the board's measured
size, never in fixed pixels — how many pixels of window the board was given is a property of the
screen the suite runs on.

## The frontend header

[`TopBar`](../src/client/components/TopBar.tsx) sits in a 52 px `AppShell.Header` above every route.
It is the part of the frontend that outlives the screen you are on: pairing a camera and taking it
for this tab has nothing to do with whether you are at home, in a lobby or mid-match, so it lives
here rather than being duplicated into three pages. It holds the wordmark, a connection indicator,
the fullscreen control, and two menus:

| Menu | Holds |
| --- | --- |
| **Cameras** | Pair scoring device, the live-video switch, and a card per paired device — claim/release, camera on/off, board camera, forget, power off. The video controls are absent entirely where the deployment carries no media |
| **Settings** | `Layout` → the appearance toggle, presentation zoom, **Edit Match Layout** with the active breakpoint badge, breakpoint-local optional-card switches while editing, **Reset layout**; `Links` → source code and, in production, third-party notices |

The camera menu sets `closeOnItemClick={false}`: every control in it is a setting rather than a
navigation, and a menu that shut on each click would make changing two things a two-trip job. Its
dropdown is width- and height-bounded and scrolls, so a long device list stays usable on a
phone-sized window. The settings menu keeps the default instead, and puts its live controls in a
plain `Box` rather than in `Menu.Item`s — only **Reset layout** is an item, and closing after it is
the right behavior for a one-shot action.

The Layout section, the appearance toggle and presentation zoom are present on every route,
including the home page. Only the match-layout controls — **Edit Match Layout**, the active
breakpoint badge and **Reset layout** — appear while a match grid has registered itself; see below.

### The first-pairing nudge

A browser with nothing in `instadarts_devices` has never paired a scoring device, and its user has
no reason to suspect the camera exists — the control that opens it is one icon among three. Until
that list is non-empty, three controls say so with the shared `.button-hint` ring: the camera control
(also `filled` rather than `default`), the **Pair scoring device** button inside its menu, and a
**Pair a Scoring Device** button the home page's **Start playing** card puts above its three ways to
start. All three call the same `startPairing`, and all three are gone once one device is paired; a
second is added from the camera menu like any other.

The nudge changes only the control's appearance: it opens the same menu whatever this browser has
paired. Its accessible name carries a different piece of state — `Cameras` on its own, and
`Cameras · N` while N paired devices are claimed by this tab and online, which is also when the icon
goes `light` rather than `default`. Playwright matches `getByRole`'s `name` as a substring, so the
many specs that reach the menu by `Cameras` work at either label; a selector that needs the whole
name has to allow the count, as `ui-features.spec.ts` does with `/^Cameras(?: · \d+)?$/`.

## Match layout editing and persistence

The settings menu exposes **Edit Match Layout** only while a live or finished match grid is
registered. Edit mode is transient and off by default. It reveals a drag handle in each box header,
an adjacent title-bar switch, the south-east resize handle, and an **Optional cards** switch list
when that profile declares any. The badge and controls describe the current RGL breakpoint: showing
a card or its title bar at `lg` does not also show it at `sm`.

Every match card's title bar may be hidden. A hidden bar returns temporarily while editing and
overlays the body with a translucent background instead of consuming grid-box height, so entering
edit mode does not move or shrink the content being used to judge the box size. Overview defaults
to hidden; other current cards default to visible.

**That overlay takes its own pointer events**, so the body pixels beneath it are inert until edit
mode is switched off — visible through the translucent strip, but not clickable. It has to be that
way: Overview hides its title bar by default and is four rows tall, so the strip covers most of its
**Leave** button, and a click meant for the title bar would otherwise end the match. Leaving is
final. Treat what shows through the strip as context, not as a target.

Title bars are presentation, not a guaranteed game surface. Titles, centred notices, badges and
header actions must therefore remain supplemental: hiding one must not remove an instruction,
state or control required to play. For example, Whac-A-Mole remains fully understandable from its
overview and mode-panel content when the mode panel's title is hidden.

**Dragging is handle-only.** RGL is given `handle: '.frontend-grid-drag-handle'`, so the header grip
is the one place a drag can begin, and the rest of the box — the dartboard, the visit buttons, a
scrolling body — keeps behaving normally while the layout is being edited, except where a title-bar
overlay covers it. The `cancel` selector alongside it is a second line of defence for ordinary
controls, not the thing that protects the board. Leaving the match or switching between the live and
summary profiles turns editing off.

RGL reports layouts for all five breakpoints. They are stored locally under the versioned key
`instadarts_frontend_layout_v1` in two independent profiles:

- `match-live` for the playing screen;
- `match-summary` for the finished screen.

Each breakpoint keeps its own arrangement, optional-card state and title-bar visibility. Active
layouts remain in the profile map; an additive inactive map keeps the complete geometry of disabled
optional cards so re-enabling one restores its last position and size at that breakpoint. Loading
accepts only the current schema version, known profiles, known breakpoints and known box ids;
inactive entries must also name a card declared optional, and title-bar entries must be boolean.
Numeric positions are bounded, current constraints are reapplied, and boxes absent from stored data
use their canonical enabled and title-bar defaults. Whether a card is switched on is read from the ids
the stored profile names rather than from the entries that survived validation, so a card with an
unusable saved position is repaired to its canonical geometry instead of being switched off.

Saving is additive in the same way. A card can be temporarily out of the roster — `mode-panel` when
the mode draws no panel, `rematch` while spectating or after somebody departs — and the state being
written then has no opinion about it. Only the ids that state does name are overwritten, so an
absent card keeps the position and title-bar choice it had and gets them back when it returns.

Malformed or unavailable local storage falls back to the defaults, and editing still works in
memory for the current page.

**Reset layout** removes every saved breakpoint, inactive-card entry and title-bar choice for the
active profile only, restores that profile's canonical geometry and card defaults, and exits edit
mode. It does not reset the other match profile, application zoom, camera settings or match state.

[`LayoutEditorContext`](../src/client/layout/LayoutEditorContext.tsx) is only the bridge from the
active match grid to the global header. Layout data does not belong to the server, protocol or match
state.

## Presentation zoom

Both settings menus offer presentation zoom from 50% to 150% in 5% steps. The frontend and scorer
use separate local-storage keys and separate root CSS variables. The saved value applies to the
whole application at every breakpoint; it is not part of an RGL layout profile.

This is CSS `zoom` on that application's `#root`. It changes presentation and available CSS layout
space, so RGL may select another breakpoint after the frontend is zoomed. It does not change browser
page zoom.

Scorer presentation zoom is also unrelated to **camera zoom**. Camera zoom is an optical/digital
track constraint remembered per lens and changes the pixels reaching the model. Presentation zoom
only scales the interface and must never change capture constraints, the square crop or calibration.
Resetting scorer setup does not reset presentation zoom.

Storage reads and writes are guarded. A blocked/private storage implementation gives the default
100% on the next page load but must not stop in-memory zoom controls from working.

The appearance toggle sits directly above the zoom row in both menus and behaves the same way — its
own key per application, guarded storage, unrelated to any RGL profile. It is described under
[Appearance](#appearance).

## Scorer presentation and sensitive geometry

The paired scorer uses the same 52 px `AppShell` header as the frontend, then a static centred
column. Its height-bounded, scrollable settings menu has **Layout**, **Camera and AI**, **Sharing and
power**, and **Device** sections. In production it also has **Links**, containing the same
third-party notices link as the frontend. Onboarding hides the header and follows the name → camera
→ self-test → optional aim sequence.

The camera preview is not an ordinary responsive image. Scoring and onboarding share
[`SquareCameraViewport.tsx`](../src/client/pages/scorer/SquareCameraViewport.tsx): a reserved square
whose video absolutely fills it with `object-fit: cover` and centred object positioning. This is the
presentation equivalent of `getCenterSquareCrop`; the longer source axis is clipped equally at both
ends, so the user sees the model's base input crop. Normalized board, motion and aim overlays stay
inside that same square.

Keep `CameraPanel` mounted while settings or calibration is shown. Its video node, stream, runtime
and model must survive presentation changes and model-resolution switches. Calibration has a
separate frozen 640×640 canvas and normalized SVG overlay. These invariants and the hardware checks
are documented in [vision.md](./vision.md#the-camera).

## Changing or testing the UI

For a new frontend page box:

1. add its canonical item to `frontendLayout.ts` — the `lg` map is the canonical card set, and an
   item without an entry there is refused at the first render rather than quietly not appearing;
2. render a `GridBox` with the same stable id through `ResponsiveBoxGrid`;
3. choose document `autoHeight` or match fixed height deliberately;
4. use Mantine inside it and add CSS only for specialized visual geometry;
5. take colour from a palette token, never from a shade you picked by eye against the scheme you
   happen to be looking at — unless the thing is artwork, in which case name a shade deliberately
   and say why in a comment;
6. verify immediately below and above the stock RGL breakpoints, and **in both colour schemes**.

For a match card that is not required for play, add
`optional: { label, defaultEnabled }` to its `ResponsiveBoxItem`. Omitting `optional` is the safety
default: the card remains mandatory and receives no visibility switch. Every optional card still
needs canonical geometry at all five breakpoints, including one that is disabled by default.

A grid instance owns one profile and one storage slot, read once at mount, so callers key
`ResponsiveBoxGrid` by profile. Changing the profile on a mounted grid is refused rather than
silently keeping the previous profile's state and overwriting the new one's saved layout.

Tests should locate a box by `[data-grid-item="<id>"]`, then use roles, labels and stable test ids
inside it. Do not encode a canonical `x`/`y`, DOM depth or sibling order unless layout persistence
itself is what the test covers. Clear the layout, zoom and appearance storage keys when a test needs
canonical state — `UI_STORAGE_KEYS` in `ui-features.spec.ts` is the list, and a new browser-level
preference belongs in it — and deliberately preserve them when testing reload persistence.

For visual work, inspect narrow portrait, short-wide and large-display viewports **in the bright
scheme as well as the dark one**; a colour pinned to the wrong end of a scale looks fine in one and
is invisible in the other, and the only way to find that is to look. Measure overflow, containment
and square geometry as well as taking screenshots. The full local procedure, including the
Playwright project ordering, is in [development.md](./development.md#the-e2e-suite).
