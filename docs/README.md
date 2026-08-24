# InstaDarts developer documentation

Internal documentation for people (and agents) developing this app — not end-user documentation.

Ground rule: **the implementation is the source of truth.** These documents describe what exists.
Anything agreed but not yet built is marked ⏳ and must not be written about as if it were there.

## Contents

- [Glossary](./glossary.md) — the domain vocabulary: user, player, lobby, match, game mode, leg, set,
  visit, dart, scoring device. Read this first; it also records where the code's names disagree with
  the words we use, and what the planned legs/sets work will have to touch.
- [User-interface architecture](./ui.md) — the shared Mantine design system, the frontend's
  responsive box grids, match layout editing and persistence, application zoom, scorer layout, and
  the boundary around specialized visual CSS. Read this before changing a screen.
- [Game modes](./game-modes.md) — the contract a game mode implements, what it may look at, and how
  the match screen is split between universal chrome and mode-provided values. Read this before
  adding a mode or touching the match screen.
- [The scoring pipeline](./vision.md) — how a camera turns a thrown dart into a number, what the
  tests cover, and the parts only real hardware can check. Read this before touching anything under
  `vision/`.
- [Media](./media.md) — the optional peer-to-peer video feature: who the server lets connect to whom
  and why that one rule is the whole security model, why a link carries no video track, and how to
  turn it off. It also covers shipped dart-evidence stills and live remote boards in online matches.
- [Working on this app](./development.md) — how to run the app, how a deployment is tuned, the tests
  and the typechecks, how to check a UI change, and the traps that have caught people here. Read this
  first if you are about to run something.

Deployment settings live in one optional file, described in
[development.md](./development.md#settings) and shown with every knob at its default in
[`instadarts.config.example.jsonc`](../instadarts.config.example.jsonc). There are no configuration
environment variables — `NODE_ENV` decides whether a build is a development one, and that is all.
