# Match-scoped media

Media is an optional property of a running match. It is not part of a lobby, does not decide whether
gameplay is valid, and is destroyed as soon as the match finishes. A rematch is a new match and gets
a new media session.

The match server is the coordinator, signaling relay, and optional STUN server. It is never a WebRTC
peer and never receives an image, encoded frame, consent choice, or private camera state.

## Ownership and lifetime

At match start the server creates a private `MatchMediaSession` with a fresh `meshId`. This state is
not part of public `MatchState`.

**A source slot is a board, and a board belongs to a user.** Online slots are keyed by the id of the
first player each user added, so two players one user brought share a slot and that user declares
once for both. One user holding the whole roster is that rule at its extreme: one slot, every player
standing at it.

**The mesh is built for at most two boards**, which covers every shape that plays: one user with any
number of players at one board, and two users however they split theirs — one each, or two and one,
or two and two. The peers are the same in each case, because the peers are the frontends and their
cameras rather than the players. Nothing here asks how the match was created; it asks how many
boards are in play.

A match with a third board gets **no session at all**: `startMediaForMatch` returns without creating
one, which is the state a deployment with `media.enabled: false` already produces, so every client
path handles it. It is not a mesh with nobody in it — no peer identity is ever minted. The match
messages carry `mediaDisabled` so the screen can say why, and the frontend does not announce itself
into a session that is never coming. An n-board mesh is a topology nobody has designed; this is where
that decision would be made.

Each frontend declares its current choice after it receives a running match:

```ts
{ type: 'media_join', matchId, tier, boardCamera }
```

The declaration is idempotent and is repeated after match start, rematch, page reload, spectator
entry, WebSocket replacement, and an explicit media/camera change. `tier: 'disabled'` with a null
camera is a complete declaration: it counts toward setup but creates no peer identity.

Lobbies have no peer IDs, rosters, signaling permissions, or peer connections. A scoring phone may
announce its capability in a lobby so its owner can see it in the camera picker, but the announcement
does not create mesh state.

On every finish path—victory, cancellation, permanent leave, or idle expiry—the server sends inactive
source directives, publishes empty rosters, and destroys the media session immediately. A rematch
creates a fresh mesh and clients resubmit their stored choices; the server copies no source selection.

A [game mode](./game-modes.md#declining-a-media-feature) may decline a feature: `bansMedia` names
`boardVideo`, `dartEvidence`, or both. The session reads it once at creation and it changes nothing
about the mesh—the same declarations, peer ids, roster and setup overlay—because a ban is about one
feature and not about media. Board video is refused where it is granted, at the source directive, so
a declined feed is never offered and the camera stays in every roster with its stills and director
edges intact. A still request never reaches the server, so that ban is honoured by the frontend not
asking.

## Identities and topology

`matchId` names gameplay. `meshId` names one media incarnation of that match. `peerId` names one live
socket inside that mesh. A WebSocket replacement therefore keeps `matchId` and `meshId` but receives a
new `peerId`; a rematch replaces all three.

Roster snapshots contain:

```ts
{
  type: 'media_peers',
  matchId,
  meshId,
  setupComplete,
  self,
  peers
}
```

`setupComplete` means every participant source slot has declared, including disabled participants.
Spectators do not delay it. If `meshId` or the client's own peer ID changes, the client closes all old
links before applying the new roster.

The roster is authorization. The server recomputes the current plan for every signal and relays only
between an exact pair present in that plan. A peer ID from an old socket, match, or rematch cannot be
used again.

The normal online topology is:

- participant frontend ↔ participant frontend;
- selected board device ↔ its owner;
- selected board device ↔ every frontend at another board;
- spectator ↔ participant frontends and selected devices;
- never device ↔ device or spectator ↔ spectator.

A match with one board has one source, and `audienceFor` derives its audience from that: there is
nobody at another board, so it is addressed to spectators alone and the playing screen never shows
self-video. Its owner/device link remains useful for stills and director commands.

Device IDs never enter a roster. The server resolves them through the private stable source slot and
current device claim. A participant frontend replacement preserves that source intent; transferring
the device to another slot or explicitly unclaiming it withdraws it.

## Source coordination and feeds

For a selected video-capable scorer the server retains this directive:

```ts
| { type: 'media_source_state', matchId, meshId, active: true,
    sourceEpoch, audience }
| { type: 'media_source_state', matchId, meshId, active: false }
```

Repeating an active directive with the same epoch is idempotent. A new match, scorer socket
incarnation, source selection, or tier reactivation creates a new epoch. The scorer creates one feed
UUID for that epoch.

The participant frontend no longer sends `video_start` or `video_stop`. The server-owned directive is
why an owner's temporary socket loss does not stop a healthy scorer feeding other recipients.
Explicit opt-out, source change, device withdrawal, scorer replacement, or match finish ends the old
epoch.

The source sends `video_offer { feedId }` over the control channel. Each recipient independently sends
`video_accept` or `video_decline`. Consent is exact-feed/exact-recipient:

- a participant or spectator peer replacement needs fresh consent;
- a scorer replacement creates a fresh feed and needs fresh consent from everyone;
- a rematch reuses no consent;
- a recovered link for the same peer and feed retains consent.

Acceptance and transport writability are separate. If every accepted link is temporarily unwritable,
the encoder stops. When the same eligible link recovers, the source repeats its offer, the recipient
repeats its choice, and encoding resumes under the same feed UUID. Acceptance is removed only by
roster removal, role loss, decline, feed end, source-epoch change, or match end.

`still_request`, still responses, `video_region`, accept/decline, feed lifecycle, pings, and keyframe
requests remain peer-to-peer. A scorer accepts still and director commands only over its exact `own`
roster edge.

## Match setup presentation

`media.setupTimeoutMs` defaults to 4000. On a mounted page the full-screen “Setting up match…” overlay
is shown once for each new match ID: initial entry, page reload, spectator entry, and rematch.

It closes when any of these is true:

- media is disabled by the deployment or this browser;
- a `setupComplete` roster has arrived and every link captured from that snapshot is ready, failed,
  closed, or subsequently removed; or
- the timeout expires.

It does not wait for camera activation, consent, a video offer, or a decoded frame. Consent dialogs are
queued behind it. The overlay is presentation only: it adds no server match phase, never blocks another
client, and times out into a fully usable virtual-board match.

An in-place WebSocket replacement, later peer arrival, or ICE outage never reopens the full-screen
overlay. Ordinary connection indicators and the virtual board cover those running-match failures.

## Transport recovery

Every successful WebSocket connection has a client-visible generation. A spectator issues `spectate`
once for each generation, then declares media after room entry. The E2E diagnostics seam exposes the
socket generation, server session ID, mesh identity, peer identity, and controlled socket replacement.

For WebRTC:

- `disconnected` is recoverable and does not rebuild the link or restart ICE;
- on `failed`, only the impolite side—the deterministic original offerer—calls `restartIce()`;
- retries run one at a time after 1, 2, 4, then capped 8-second delays;
- connection, link close, roster removal, socket replacement, mesh change, and teardown cancel pending
  retry work.

Media uses two data channels and no WebRTC media tracks. Control is ordered/reliable. Encoded video is
unordered with no retransmission; a late frame is useless. A scorer encodes once with WebCodecs and
fans the same chunk out to accepted writable recipients.

STUN only helps peers discover public addresses. `media.iceUrls` defaults to `["internal"]`, resolved by
the browser to the host it reached and `media.stunPort` (3478 by default). There is no TURN relay, so
unconnectable NAT combinations fall back to the virtual board.

## Contract boundaries

Media state lasts only as long as the in-memory match server. Server restart recovery and persistence,
TURN, and server participation in the media data plane are outside the contract. Two misbehaving peers
can keep their own connection alive after teardown, but the server will no longer authorize signaling
and no valid client carries it across the match boundary.

The E2E diagnostics are enabled only in a development/E2E build with `?e2e=1`. They expose live
identities, link states, ICE stats, source/feed state, socket replacement, and same-peer fault injection;
they are absent from production builds.
