# Contributing to InstaDarts

InstaDarts is a self-hosted darts application with browser match screens and phone-based camera
scoring. Contributions are welcome, including bug reports, feature ideas, code, documentation, and
corrections.

## Ways to contribute

- **Report a bug or propose an improvement:** open a GitHub issue.
- **Improve the documentation:** submit a focused pull request that keeps the docs aligned with the
  implementation.
- **Submit code:** open a small, tested, and documented pull request.
- **Report a security vulnerability:** follow the private reporting process below.

Before changing code or documentation, read [`docs/README.md`](docs/README.md). It maps the developer
documentation. In particular, read the domain vocabulary in
[`docs/glossary.md`](docs/glossary.md) and the setup and testing guidance in
[`docs/development.md`](docs/development.md).

Product-level planned work is listed in [`ROADMAP.md`](ROADMAP.md), and notable completed changes
are recorded in [`CHANGELOG.md`](CHANGELOG.md).

## Reporting bugs and proposing improvements

A useful bug report includes:

- what you did, what happened, and what you expected;
- whether it reproduces under `npm run dev`;
- the browser and device involved;
- relevant server output.

For camera-pipeline issues, also include the configured model input size and whether WebGPU was
enabled. For an improvement, describe the problem it solves and the desired outcome.

## Security reports

Do not report security vulnerabilities in a public issue or pull request. Use GitHub's private
*Security → Report a vulnerability* form so the maintainer can address them before disclosure.

## Pull requests

### Set up the project

InstaDarts requires Node.js 22 or newer.

```sh
npm ci
npx playwright install    # first time only, for the browser suite

npm run dev               # the whole app on 3000 (http) and 3001 (https), one process
npm test                  # unit tests (Vitest)
npm run test:e2e          # browser tests (Playwright)
npm run build             # production build and typechecking
```

Playwright starts the server it needs, so do not start a development server specifically for an
end-to-end test run. If `npm run dev` is already running, Playwright reuses it and its current state.
See [`docs/development.md`](docs/development.md#the-e2e-suite) for details.

### Keep the change focused

One pull request should contain one feature or fix. Split work that crosses layers into a series of
independently useful, passing changes where possible. If a change cannot sensibly be split, explain
why in the description.

Do not include:

- unrelated reformatting, renames, refactoring, or features;
- new dependencies;
- generated or local files such as `dist/`, `release/`, `test-results/`, `plans/`, temporary
  `plan-*.md` files, or a deployment's `instadarts.config.jsonc`.

Check `git status` before pushing.

### Test behaviour, not implementation

Every behaviour change requires tests that verify the intended result. Use the cheapest level that
can observe it:

| Test | Where | Use it for |
| --- | --- | --- |
| Unit (Vitest) | `tests/unit/` | Rules, scoring, protocol parsing, validation, storage, and other behaviour that does not need a browser |
| End-to-end (Playwright) | `tests/e2e/` | UI behaviour, pairing, reconnects, multiple clients, and behaviour that requires sockets |

A bug fix requires a regression test that fails without the fix. If a change breaks an existing
test, update how the test locates or sets up the behaviour without weakening what it asserts. If the
old expectation is the bug, explain the old and new expectations in the pull-request description.

For stable Playwright selectors and other test guidance, see
[`docs/development.md`](docs/development.md#tests-that-do-not-break-for-the-wrong-reason).

### Keep the documentation accurate

Update the relevant documentation in the same pull request whenever implementation behaviour
changes. Documentation must describe what exists, not planned or assumed behaviour.

For an imminent change, a temporary `plan-<topic>.md` may describe implementation steps while the
work is active. Remove it after the work is completed or cancelled, and do not include it in a pull
request. Accepted product-level plans belong in [`ROADMAP.md`](ROADMAP.md) as outcomes rather than
implementation instructions. Record notable completed user-facing changes under **Unreleased** in
[`CHANGELOG.md`](CHANGELOG.md).

| Change | Documentation |
| --- | --- |
| Domain concepts or inconsistent terminology | [`glossary.md`](docs/glossary.md) |
| Lobby, match, seat, reconnect, departure, re-match, or expiry behaviour | [`match-lifecycle.md`](docs/match-lifecycle.md) |
| Screens, cards, grids, themes, or stylesheet rules | [`ui.md`](docs/ui.md) |
| Game modes, mode contracts, or match-screen structure | [`game-modes.md`](docs/game-modes.md) |
| Scoring-device runtime, camera, model, geometry, or calibration | [`vision.md`](docs/vision.md) |
| Peer connections, rosters, stills, or live video | [`media.md`](docs/media.md) |
| Running, building, configuration, testing, or common reproducible pitfalls | [`development.md`](docs/development.md) |

Do not add machine- or network-specific problems to `development.md`. `README.md` is for people
deploying the app; `docs/` is for people changing it.

### Follow the project conventions

- **The server is authoritative.** It computes scores, turn order, and match state. Validate all
  client input.
- **The client contains no game rules.** The server sends mode-specific values in `ModeView`; game
  modes do not know about matches, sets, or sockets.
- **`src/shared/` is the only tree imported by both client and server, and it contains no I/O.**
- **Use Mantine first.** There is no utility-CSS framework. See
  [`ui.md`](docs/ui.md#design-system-ownership) for the limited responsibilities of `index.css`.
- **Use the project palette and support both colour schemes.** Fixed colours are reserved for
  artwork such as the board, darts, QR codes, and camera overlays. See
  [`ui.md`](docs/ui.md#theming).
- **Comments explain why.** Match the density and voice of the surrounding code.
- **The build includes typechecking** for the client, server, configuration, scripts, and tests.

### AI-assisted contributions

LLM-written and LLM-assisted contributions are welcome and follow the same standards as any other
contribution:

- You are responsible for understanding and defending the submitted work.
- Tests must verify intended behaviour, not merely the generated implementation.
- Documentation must describe the actual implementation.
- Follow the project's conventions and do not include generated extras, dependencies, or unrelated
  changes.

### Commits and the pull-request description

Use an imperative commit subject with an existing prefix such as `feat:`, `fix:`, `refactor:`,
`docs:`, or `test:`. Use the body for reasoning that does not belong in a code comment. Rebase onto
`main` instead of merging it, and keep the history readable.

The pull-request description should state:

1. What changed and why.
2. Which test suites ran and their results.
3. Which documentation changed, or why none was needed.
4. Whether an existing test's intent changed and why.
5. What was deliberately left for follow-up work.

### Licensing

InstaDarts is licensed under the **GNU Affero General Public License v3.0 only**
([`LICENSE`](LICENSE)). By opening a pull request, you agree that your contribution is licensed under
the same terms.

Only include code from another project when its licence permits it, and identify its source in the
pull-request description and a code comment. The detection model weights in
`src/client/public/models/` are project-owned and carry the same licence; do not submit other weights
or training data. See [`vision.md`](docs/vision.md#where-the-model-came-from).

### Before opening a pull request

- [ ] The diff contains one feature or fix and no unrelated changes.
- [ ] `npm test`, `npm run test:e2e`, and `npm run build` succeed.
- [ ] New behaviour has tests; a bug fix has a test that fails without the fix.
- [ ] Existing tests retain their intent unless the description explains why it changed.
- [ ] Documentation is updated where necessary.
- [ ] Temporary plan files are removed; the roadmap and changelog are updated where relevant.
- [ ] The diff contains no new dependencies, generated files, or local configuration.
- [ ] The description explains the change, verification, documentation, and follow-up work.
