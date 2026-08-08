# InstaDarts developer documentation

Internal documentation for people (and agents) developing this app — not end-user documentation.

Ground rule: **the implementation is the source of truth.** These documents describe what exists.
Anything agreed but not yet built is marked ⏳ and must not be written about as if it were there.

## Contents

- [Glossary](./glossary.md) — the domain vocabulary: user, player, lobby, match, game mode, leg, set,
  visit, dart, scoring device. Read this first; it also records where the code's names disagree with
  the words we use, and what the planned legs/sets work will have to touch.
- [Game modes](./game-modes.md) — the contract a game mode implements, what it may look at, and how
  the match screen is split between universal chrome and mode-provided values. Read this before
  adding a mode or touching the match screen.
- [Working on this app](./development.md) — how to run the app, the tests and the typechecks, how to
  check a UI change, and the traps that have caught people here. Read this first if you are about to
  run something.
