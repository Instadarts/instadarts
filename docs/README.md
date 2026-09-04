# InstaDarts developer documentation

Internal documentation for people (and agents) developing this app — not end-user documentation.

Ground rule: **the implementation is the source of truth.** These documents describe what exists.
Use a temporary `plan-<topic>.md` for implementation steps while an imminent change is active, then
remove it when the work is completed or cancelled. Planned work does not belong in these documents,
which describe the current state.

## Contents

- [Glossary](./glossary.md) — domain vocabulary and naming conventions.
- [Match lifecycle and session ownership](./match-lifecycle.md) — lobbies, matches, seats,
  reconnects, departures, re-matches, and deadlines.
- [User-interface architecture](./ui.md) — the design system, themes, responsive grids, layout
  editing, the dartboard, and scorer UI.
- [Game modes](./game-modes.md) — the mode contract, settings, match-screen integration, and layer
  boundaries.
- [The scoring pipeline](./vision.md) — the camera and model pipeline, test coverage, and checks that
  require real hardware.
- [Media](./media.md) — peer-to-peer connections, authorization, dart-evidence stills, and live board
  video.
- [Working on this app](./development.md) — setup, configuration, releases, tests, and common
  contributor pitfalls.

Want to contribute? See [CONTRIBUTING.md](../CONTRIBUTING.md) for how to report issues and submit
pull requests, and [CHANGELOG.md](../CHANGELOG.md) for notable completed changes.

Deployment settings live in one optional file, described in
[development.md](./development.md#settings) and shown with every knob at its default in
[`instadarts.config.example.jsonc`](../instadarts.config.example.jsonc). There are no configuration
values in environment variables: `INSTADARTS_CONFIG` and `INSTADARTS_DIR` only locate the settings
file. The environment variables that remain describe the run rather than the deployment —
`NODE_ENV` selects the build environment, `CLIENT_DIR` names the built client to serve (and naming
it is what asks for it to be served at all), `DEV_CLIENT` asks for the Vite dev client instead, and
`QUIET` suppresses startup chatter.
