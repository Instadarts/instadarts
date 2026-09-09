# Changelog

## Unreleased
- Board video is cut to the board: a scoring device blacks out everything outside the board's rim
  before the frame is encoded. **On by default**, so a phone that publishes video will look different
  after this upgrade — the room around the board is gone. Turn it off per device under
  Settings → Sharing and power → **Board only**. It keeps somebody's living room out of the picture
  and spends the bitrate on the board instead, and it changes nothing about scoring. See
  [docs/media.md](docs/media.md).
- Published video frames can carry an optional block naming where the board is in them: the
  homography, the lens coefficient and the published square. It costs fifty-two bytes on the frames
  that carry one, and it is what the next entry reads.
- **Straighten board video** (Settings → Layout, off by default): a remote board is laid square-on
  over the virtual board and cut to the rim, so every board looks the same whatever angle its camera
  stands at and the video sits on the drawing underneath it. A per-browser display choice — it sends
  nothing, asks nothing of a camera, and changes nothing that is scored. Lens correction is not
  applied to the picture; see [docs/media.md](docs/media.md#straightening-it-on-the-viewer).

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
