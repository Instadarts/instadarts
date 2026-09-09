# Changelog

## 1.2.0
- Match integration API: an authenticated HTTP API for external software to create matches with a
  fixed roster and settings, hand each player a personal invite link, discover installed game modes,
  list and read its own matches, cancel one, and retain full results for 24 hours. Live updates use
  the existing spectator WebSocket. Off by default; enable it with `server.apiKeys`. See
  [docs/API.md](docs/API.md).
- Lobbies now show server errors on the lobby screen instead of discarding them.

## 1.1.1
- Match-UI: Add vertical mode to visit card.
- Match-UI: reduce minimum height of score card.

## 1.1.0
- Many bug fixes and protocol hardening.
- Small UI fixes.

## 1.0.0
Initial release.
