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
frontend router or layout-editor provider. Crossing from one to the other is therefore a page load:
the home page's scoring-device link — for the device that opened `/` when it wanted `/scorer` — is a
plain anchor, because a router link would look for a route that does not exist and bounce straight
back home. It is the one home grid item rendered without a card, since it leads off the page rather
than offering something to do on it.

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
and its treatment, in the one place they are decided. Four screens show it — both headers, the home
page and the screensaver — and two of those used to be duplicated markup.

**The mark is drawn once**, in [`mark.svg`](../src/client/components/mark.svg), in `currentColor`. `Wordmark` inlines the file rather than pointing an `<img>` at it,
because an image is a separate document and inherits nothing — inlining is what lets the mark take
the accent tint in a header and go dim on the screensaver. A tab icon has neither a colour to inherit
nor a page behind it, so the `favicon` plugin in [`vite.config.ts`](../vite.config.ts) wraps *those
same shapes* in a ground and a colour, serving `/favicon.svg` in dev and writing it once at build.
The tab icon is therefore not a second drawing that can drift; it was, and it did. Anything the
shape needs must be set on the shape rather than on the file's root element, because the wrapper
lifts the shapes out of it.

The mark is sized in `em` and everything in the lockup is phrasing content, so the mark and the
tracking scale from one font size. (The gap between them does not: it is `Group`'s fixed 1 rem.) That is what lets the home page pass it to
[`AutoFitText`](../src/client/components/AutoFitText.tsx) and have the *drawing* shrink with the
word: `Wordmark`'s `fitTo` takes a maximum in pixels instead of an `fz`, and the line is measured
against its parent the same way the match headline is. It needs to. At a fixed `3rem` the lockup is
434 px wide whatever is around it, and the home card is narrower than that below roughly 470 px of
viewport, so the card's own `overflow: hidden` cut the end off the name. Two things about reusing
`AutoFitText` this way are worth knowing, because both were silent:

- the fit sets a **font size and nothing else**, so anything passed as children that is measured in
  pixels will not scale, and a Mantine `Text` will not scale either — `Text` applies its own `md`
  size rather than inheriting one. The word is a `Box` for that reason, and carries `Text`'s
  truncation by hand, which the headers still need;
- the host's `flex: 1 1 0` is right inside a row that shares its width and wrong inside a `Stack`,
  where a flex basis of zero is a *height* of zero and the line vanishes into a host with no height
  and `overflow: hidden`. `grow={false}` is the way out;
- **it needs a box whose width does not depend on it.** A `centered` `AppCard` shrinks its content
  box to fit, and a fitted line is usually the widest thing in that box — so the box is as wide as
  the line, the line is fitted to the box, and the two settle on one size for every screen instead of
  on the card's. The home page's welcome card is therefore not `centered`; its `Stack` centres its
  own children. Watch for the symptom rather than the cause: a fit that no longer responds to the
  window, and a box as wide as whatever the longest line of prose in it happens to be.

Its detail is set by the smallest sizes it is used at rather than by how it looks in isolation — the
two headers at about 21 px, where it is seen most, and 16 px on the screensaver. A third ring on the
board merges into a blob under about 26 px, which is why there are two. Redraw it against the sizes
in `mark.svg`'s comment, not against one large preview.

Do not put RGL inside a box. The outer grid decides which boxes share a row; Mantine primitives
decide how the contents of one box flow. Keeping that boundary makes a box reusable and prevents a
page layout from leaking into its contents.

There is no utility-CSS framework in this repository. Prefer a Mantine prop or component before
adding CSS. A small inline style is appropriate when it expresses geometry that Mantine has no prop
for — and inline style is where most specialized geometry ends up, so do not go looking for a
stylesheet that does not exist. Mantine, RGL and react-resizable bring their own imported styles;
within the application source, custom rule sets are authored in exactly two places.

[`index.css`](../src/client/index.css) is the application stylesheet, and is intentionally short. It
owns what has to apply to elements the components do not render themselves, or to the document root:

- the `html`/`body`/`#root` reset, and the app-wide `user-select: none` with selection restored
  inside text fields;
- RGL item fill, overflow, edit outlines, drag cursors and resize handles;
- `.frontend-board-area`, the size container the square dartboard is measured against;
- `.app-main` and `.scorer-column`, the application background and the scorer's column width;
- `.button-hint`, the pulsing ring any control can wear while it is the thing to press next — a
  shared helper rather than one feature's rule, and here only because keyframes cannot be inline
  style. Its ring colours are `--button-hint-ring` and `--button-hint-ring-fade`, so a second
  highlight recolours itself on its own element instead of adding a second animation;
- the root presentation-zoom variables for both applications;
- `font-variant-numeric: tabular-nums` on the body, so a changing total stops shuffling the digits
  beside it. Every number on these screens is a score being compared to another one.

It carries **no colour of its own.** Every value it paints is a palette token — see
[Theming](#theming) — so the stylesheet does not need a second copy of itself per colour scheme, and
adding one would be the thing that made it long.

Do not rebuild ordinary card, form or responsive layouts there, and do not add application `@media`
breakpoints for the regular frontend.

[`whac-a-mole.tsx`](../src/client/modes/whac-a-mole.tsx) is the other one. A mode that animates needs
keyframes, and keyframes cannot be expressed as inline style, so it portals a `<style>` element into
`document.head` holding its own animations and their `prefers-reduced-motion` override. A new mode
needing animation should follow the same pattern rather than adding to `index.css`.

That block reaches two surfaces outside the mode's own panel, and the two are not the same kind of
thing. It sets the board's active cursor through `[data-testid="dartboard"]` — a genuine reach,
alongside the DOM lookup recorded in
[the glossary's remaining leaks](./glossary.md#mode-specific-vocabulary-in-mode-agnostic-layers). It
also decorates the visit row's last slot through `[data-visit-slots]`, which is **the sanctioned
route**: `VisitInput` reflects each slot's semantic tone as `data-slot-tone`, so a mode styles its
own contributed content by what it said about that content. The generic component knows about no
mode; the mode-specific half is the selector, and it lives in the mode's file. A mode wanting to
decorate what it sends should do it this way.

That stylesheet is rendered, not static, so a rule can be **added and removed with the state it
describes** — Whac-A-Mole appends one only while this visit's bonus throw is in play. It is the way
to express what the slot's own tone cannot: several states send the same tone, and they are one rule
apart if the mode's panel already knows them apart. It usually does, because a mode's panel is drawing
that state anyway. Prefer it to reaching into the DOM, and prefer it to re-deriving a rule the server
has already decided — reuse the fact you are already painting from, not the reasoning behind it.

Everything else visual outside that mode-specific stylesheet is inline style plus Mantine props: the
square camera viewport, the SVG board and its overlays, precision aiming, the canvas and video
layers, and the screensaver's capture and reveal behavior. Not one of those components carries a
`className` — `VirtualBoard`'s `.frontend-board-area` wrapper above is the single exception. Its
container geometry could technically be inline too; the class keeps the shared board-area rule with
the rest of the application stylesheet.


## Theming

Colour is decided in one file and spent everywhere else.
[`palette.ts`](../src/client/layout/palette.ts) holds an `AppPalette`: the Mantine colour tuples, the
`white`/`black` pair, and one record of semantic tokens per colour scheme.
[`appTheme.ts`](../src/client/layout/appTheme.ts) spends it. **To change the application's colours,
edit that palette** — or write a second `AppPalette` beside it and change the one export at the
bottom of the file. Nothing else has to move.

It reaches the screen as two layers, and they do different jobs.

**The tuples substitute Mantine's own, under Mantine's own names.** Every `bg="dark.8"`,
`c="gray.6"`, `color="yellow"` and `var(--mantine-color-green-5)` in the application already resolves
through `theme.colors`, so replacing `dark`, `gray`, `green`, `red`, `yellow`, `orange`, `blue` and
`cyan` recolours nearly everything without a component being touched and without a prop being
renamed. `theme.white` and `theme.black` are the same lever one level up: Mantine derives
`--mantine-color-body` and `--mantine-color-text` from them, so those two strings set the ground of
each scheme.

**The tokens are the semantic half, and they are what makes the bright scheme correct rather than
merely inverted.** The two schemes do not stack their surfaces the same way, so no single shade
number is right on both; a card asks for `var(--instadarts-surface)` and stops having an opinion.
`appCssVariables` — a Mantine `cssVariablesResolver` — emits every token under `:root` and the two
`[data-mantine-color-scheme]` selectors. That is why the application needs no PostCSS plugin
(`light-dark()` and Mantine's `@mixin`s are unavailable here) and why a second scheme adds no rule
set to `index.css`, which keeps the two-places rule above true.

The vocabulary, all prefixed `--instadarts-`: `app-bg` and the two `app-glow-*` washes over it;
`surface`, `surface-header`, `surface-raised`, `surface-sunken` and `header-bg`; `border` and
`border-strong` — `--mantine-color-default-border` is redirected to the first, so every `withBorder`
surface follows the palette from one line; `edit-outline` and `edit-overlay`; `accent` and `link`;
`hint-ring` and `hint-ring-fade`; `score-glow`; the two `shadow-*` values that `theme.shadows` is
written in terms of, so one shadow scale serves both schemes; and the twelve
`tone-{default,muted,accent,positive,warning,danger}-{fg,bg}` values behind
[`modeText.ts`](../src/client/components/modeText.ts). A new token earns its place by being asked for
in more than one component, or by needing a different answer in each scheme.

One name in that prefix is not a palette token: `--instadarts-card-header-bg` is a hook `AppCard`
leaves open, defaulting to `surface-header`. Mantine's `bg` prop is an **inline style**, so a
stylesheet rule cannot repaint a surface a component painted that way — the edit-mode title bar
overrides the variable instead. Reach for the same trick when a rule has to win over a `bg`.

### Surface separation is a number, not a judgement

Neighbouring surfaces have to be told apart, and a dark scheme is where that is easy to get wrong:
shades picked by eye once left the page and the cards on it 5.3 apart in L*, which reads as one flat
wash. Every element was where it should be, so no browser test noticed.
[`palette.test.ts`](../tests/unit/palette.test.ts) holds the palette to these, in both schemes:

| Pair | Minimum |
| --- | ---: |
| a surface against the one it sits on (`app-bg` → `surface`, `surface` → `surface-raised`/`-sunken`) | ΔL* 6 |
| `surface` → `surface-header`, which is meant to be felt rather than seen | ΔL* 4 |
| `surface` → `border`, a thin shape and so a bigger step | ΔL* 12 |
| a surface → the text drawn on it | contrast 7.0 |
| a surface → `tone-muted-fg`, `accent` or `link` on it | contrast 4.5 / 3.5 |
| each `tone-*-fg` → its own `tone-*-bg` | contrast 4.5 |

The two measures answer different questions. Whether two large blocks *look* like separate surfaces
is about perceived lightness, and L* is uniform enough to ask it with one threshold for both schemes
— a WCAG ratio is not, because the same ratio buys far less separation near black than near white.
Whether text can be *read* is a WCAG question, so text keeps the ratio.

### Chrome is themed. Artwork is not.

This is the boundary to check before recolouring anything. The board, a dart, a QR code and the
scorer's camera overlays are objects rather than surfaces: they look the same whatever the interface
is doing, and a QR code is only scannable black on white. Those keep literal colours, or a fixed
`dark.N`/`gray.N` — **Mantine tuples are scheme-independent, so naming a shade is how something stays
put** while a token is how something follows.

Deliberately not themed today: `Dartboard`, `boardGeometry`, `PrecisionDart`, `DartMarker`,
`dartboardPrecision`, `QrCode` and the white `Paper` that gives it its quiet zone, the scorer's
`BoardOverlay`, `CalibrationView` canvas, `CameraPanel` HUD and `SquareCameraViewport` backing,
`Screensaver`'s black, the dev latency chip on its black pill, and in
[`whac-a-mole.tsx`](../src/client/modes/whac-a-mole.tsx) both the mole/earth/mallet artwork and the
whole finale, which is a curtain drawn over the board rather than a surface inside a card. That
mode's HUD, player rows and stat tiles *are* chrome and do follow the palette.

Two e2e specs depend on this boundary holding: `match.spec.ts` asserts exact dart hex values and
`scorer-screensaver.spec.ts` asserts `rgb(0, 0, 0)`. If either breaks after a palette change, the
boundary was crossed rather than the test being stale.

### Appearance

Bright or dark, remembered per application, exactly the way presentation zoom is.
[`appColorScheme.ts`](../src/client/layout/appColorScheme.ts) is the same shape as `appZoom.ts` — two
`localStorage` keys, guarded reads and writes, `instadarts_frontend_color_scheme_v1` and
`instadarts_scorer_color_scheme_v1` — plus an `appColorSchemeManager`, which is the
`MantineColorSchemeManager` `MantineProvider` is given. Mantine's stock manager keeps one value for
the whole origin, and that would make a phone propped at the board follow whatever the television
last chose.

**The default is dark, and `auto` is not offered.** Nobody's application changes appearance because
they upgraded; bright is something a person asks for. `defaultColorScheme` carries the default and
the storage stays empty until the control is used.

The scheme is applied twice, and both are needed. An inline script in
[`index.html`](../src/client/index.html) sets `data-mantine-color-scheme` from the right key before
anything is painted — `main.tsx` is a module and therefore deferred, so without it a dark
installation flashes Mantine's light body on every load. It is the one place those key names are
repeated, because nothing bundled runs early enough to be asked. The provider then owns the value
for the page's lifetime.

The control is [`AppearanceControl`](../src/client/components/AppearanceControl.tsx), shared by both
settings menus and sitting directly above each one's zoom row in the same shape: a label, and the
thing to press on the right. It writes through whichever provider is above it, so it does not know
which application it is in. The icon shows the scheme in force and the accessible name says what
pressing it will do, which is why that name changes with state.

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
Current code replaces stored constraints with these current declarations when it restores a saved
position, so old browser data cannot retain a rule that the application removed.

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
including the home page. Only the match-layout controls — **Edit Match Layout**, the active breakpoint badge and **Reset layout**
— appear while a match grid has registered itself; see below.

### The first-pairing nudge

A browser with nothing in `instadarts_devices` has never paired a scoring device, and its user has
no reason to suspect the camera exists — the control that opens it is one icon among three. Until
that list is non-empty, three controls say so with the shared `.button-hint` ring: the camera control
(also `filled` rather than `default`), the **Pair scoring device** button inside its menu, and a
**Pair a Scoring Device** button the home page's **Start playing** card puts above its three ways to
start. All three call the same `startPairing`, and all three are gone once one device is paired; a
second is added from the camera menu like any other.

The control's accessible name stays `Cameras` either way. It opens the same menu whatever this
browser has paired, and a great many e2e specs reach the camera menu by that name.

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
Numeric positions are bounded, current constraints are reapplied, and newly introduced boxes use
their canonical enabled and title-bar defaults. Whether a card is switched on is read from the ids
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
column. Its settings are a height-bounded, scrollable header menu, grouped `Layout` — appearance and
presentation zoom — → `Camera and AI` → `Sharing and power` → `Device`, and in production a final
`Links` → third-party notices, the same link the frontend menu carries. Onboarding hides the header and keeps its existing name →
camera → self-test → optional aim state machine.

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
