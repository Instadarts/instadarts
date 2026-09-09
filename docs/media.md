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

**The mesh supports at most two boards:** one user with any number of players at one board, or two
users however they split their players. The peers are frontends and scoring devices rather than
players, so the topology depends on the number of boards, not how the match was created.

A match with a third board gets **no session at all**: `startMediaForMatch` returns without creating
one, which is the state a deployment with `media.enabled: false` already produces, so every client
path handles it. It is not a mesh with nobody in it — no peer identity is ever minted. An n-board
mesh is a topology nobody has designed; this is where that decision would be made.

The match messages carry **`mediaDisabled`** so the frontend does not announce itself into a session
that is never coming. It gates `useMediaMesh`'s `matchId` in
[`App.tsx`](../src/client/App.tsx). The screen shows no media status for this case: no feed is
offered, and the match continues on the virtual board.

Each frontend declares its current choice after it receives a running match:

```ts
{ type: 'media_join', matchId, tier, boardCamera }
```

The declaration is idempotent and is repeated after match start, rematch, page reload, spectator
entry, WebSocket replacement, and an explicit media/camera change. `tier: 'disabled'` with a null
camera is a complete declaration: it counts toward setup but creates no peer identity.

`MediaTier` is the scoring device's offer: `disabled`, `stills`, or `video`. The frontend separately
nominates at most one claimed device as its `boardCamera`; none is valid. A device becomes a media
source only when its own tier and the frontend's nomination both allow it. The frontend's media
switch controls whether that browser participates at all, while the board-camera choice controls
only whether it publishes its board. The tier says how much of its view a phone is willing to send;
the **board mask** below says how much of that picture is board rather than room. Both belong to the
phone, and neither can be changed from the other end.

Lobbies have no peer IDs, rosters, signaling permissions, or peer connections. A scoring phone may
announce its capability in a lobby so its owner can see it in the camera picker, but the announcement
does not create mesh state.

`media_ready` is retained on the connection even before pairing, then applied when the scorer
proves its identity. Unpaired connections cause no topology planning, and repeating the same
normalized tier causes no owner publication or planning. A changed tier updates the owner's
camera picker and replans only matches that nominated that device. Source nominations are checked
even when the device has no current peer binding, so readiness can reactivate a disabled source.
Device leave and identity synchronization likewise refresh selected matches rather than every
session. The dispatcher does not repeat the refresh already performed by a media handler.

On every finish path — victory, cancellation, permanent leave, or idle expiry — the server sends
inactive source directives, publishes empty rosters, and destroys the media session immediately. A
rematch creates a fresh mesh and clients resubmit their stored choices; the server copies no source
selection.

A [game mode](./game-modes.md#declining-a-media-feature) may decline a feature: `bansMedia` names
`boardVideo`, `dartEvidence`, or both. The session reads it once at creation and it changes nothing
about the mesh — the same declarations, peer IDs, roster and setup overlay — because a ban is about
one feature and not about media. Board video is refused where it is granted, at the source directive,
so a declined feed is never offered and the camera stays in every roster with its stills and
director edges intact. A still request never reaches the server, so that ban is honoured by the
frontend not asking.

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

The participant frontend does not send `video_start` or `video_stop`. The server-owned directive
means an owner's temporary socket loss does not stop a healthy scorer feeding other recipients.
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

Audience values are `owner`, `opponent`, and `spectator`. They authorize an offer, not delivery: a
recipient must still accept the exact feed, remain in the roster, and be eligible for the current
source epoch. Missing, empty, or invalid audience input is clamped to `owner`, never expanded to
every role.

### Regions, stills, and dart evidence

A `Region` is a square in normalized board space, described by its centre and side length in
`[0, 1]`. `{ cx: 0.5, cy: 0.5, size: 1 }` means the whole board. It describes what to show rather than
camera pixels, so the same request works from every camera angle. `clampRegion` moves an outlying
centre inward until the square fits instead of rejecting or shrinking the request.

A still is one square JPEG of a region, captured on request and returned on the reliable control
channel. Only the selected camera's owner may request one, and the request names the audience for
the response. Output size comes from `media.still.size`; mime type and quality are fixed in
[`shared/media.ts`](../src/shared/media.ts).
Queued captures retain the requesting owner link, mesh and camera-stream identity. The scorer
rechecks all three and current ownership before capture and after each asynchronous step; a
restart, roster removal or replacement owner link discards the old work.

**Dart evidence** is the still associated with a slot in the visit in progress. The owner requests
it when a dart appears, every eligible viewer receives the same image, undo removes it with the
dart, and submitting clears it with the visit.

Each accepted dart receives a server-assigned `id`; the first dart also establishes the current
visit's `id`. Appending and undo preserve the remaining identities, while a replacement dart gets
a new one even at identical coordinates. Evidence requests carry
`{ kind: 'dart_evidence', matchId, boardId, visitId, dartId, dart }` in the opaque still `tag`, with
`dart` the zero-based slot. The scorer echoes the tag without interpreting it. Receivers require
the identities to match the current match state and the sender to be the roster's selected camera
for that board. The requesting owner also checks the response `id` against its pending request;
observers receive the fan-out without issuing their own requests. Duplicate replies cannot replace
an accepted image. Missing or outdated identity tags are ignored, including index-only tags from
older clients. A change of board, visit or camera link clears evidence; undo/replacement removes
only affected dart images and requests fresh ones where needed.

### Director commands and the virtual camera

`video_region` asks the selected camera to show a board region, optionally naming a transition time
and how long to hold the shot before returning to the full-board crop. It is an owner-only command.
The dart-evidence path sends it beside each still request so remote video follows the photographed
dart.

Commands are fire-and-forget, so a shot has a reset deadline. Omitting the transition cuts directly;
omitting the reset uses `media.virtualCamera.resetMs`; `resetMs: 0` means the caller will send the
release itself.

The **virtual camera** implements the move as an interpolated `drawImage` source rectangle. It
re-resolves the requested board region on every frame, allowing a feed to start on the centred base
crop and move into place once board geometry is available. A command that interrupts another begins
from the current interpolated position.

### Blacking out the room

A scoring phone is pointed at a board in somebody's home, and the square it publishes carries
whatever is around that board. **Board only** — a per-device setting beside the tier, on by default —
fills everything outside the board's rim with black before the frame reaches the encoder.

It is drawn by the virtual camera, on the same canvas and in the same `drawImage` pass as the shot
above. [`boardMask.ts`](../src/client/vision/boardMask.ts) projects the board's outer circle — the
sisal rim at 225mm, so the number ring stays visible — through the inverse homography and the lens,
exactly as a still's four corners are projected, and the fill is one even-odd path: the whole canvas,
then the board. The outline is recomputed only when a new homography is solved, which on a
motion-gated pipeline watching a still board is seconds apart, so a frame costs one affine over 128
points and a flat fill.

**It is not a warp.** The board keeps the shape the camera saw it in; only the surroundings change.
Rectifying it to front-facing needs a per-pixel inverse map and therefore a GPU, on a phone that is
already running the detection model — see [Geometry travels with the frame](#geometry-travels-with-the-frame)
for what a receiver would need to do it instead.

**No homography means no mask.** The same honesty as the fallback crop: a feed that has not located
the board publishes its camera's own square, unmasked, rather than guessing where to put the black.
The same is true of a homography that will not invert, a board that projects across the horizon, and
one that comes out too small to believe — that last guard exists because a wrong homography is the
only failure here that is silent, and it reaches a viewer as a black square nobody at the source can
see.

**It changes only what is published, never what is scored.** Inference reads the `<video>` element
directly and never this canvas. Turning it on must not move a single tip.

### Live board video

Consent decides what a viewer *may* decode; the screen decides what it shows, and the two are not the
same question. A frontend covers its virtual board with one feed at a time, chosen by
[`selectVideoFeed`](../src/client/hooks/useVideoFeed.ts) from the board whose turn it currently is:

- **a participant** sees a board only on a turn taken at *another* board. Never their own — they are
  standing at it — which is also the whole of a single-board match without that being a case of its
  own;
- **a spectator** sees the current player's board, whichever it is;
- **nobody** sees anything while there is no current board to key the choice on — no match, or one
  still arriving.

That feed must also be accepted, decoding, and **fresh**: a frame older than `VIDEO_STALL_MS`
(3000 ms) marks the feed `stalled` rather than `live`. Declined, unavailable, waiting and stalled all
resolve the same way — the picture is not drawn and the virtual board underneath it stays visible.
Uncovering the board is the fallback for every video failure in this document, which is why none of
them needs to interrupt a match.

Feed labels are derived from match participants, never from the device that publishes them: a board
is labelled with everybody who throws at it, so one user who brought two players gets one board
carrying both names. Feed identity remains an opaque source-generated UUID, and peer rosters
deliberately carry no device names.

### Straightening it on the viewer

A board photographed from off to one side — which is where the model
[wants the camera](./vision.md#the-camera) — arrives as a lopsided ellipse laid over a perfectly
round drawing of the same board. **Straighten board video** (Settings → Layout, off by default) puts
it square-on and in register, using the geometry the frame carries.

It is one CSS `matrix3d`, and nothing else: **a `matrix3d` on a flat element is a homography**. The
browser computes three linear combinations of the element's own coordinates and divides by the third,
which is the same arithmetic and the same perspective divide, per pixel and in the compositor. No
canvas, no shader, no second copy of the picture.

That is worth stating plainly because [`videoCamera.ts`](../src/client/vision/videoCamera.ts) argues
at length that CSS *cannot* do this. That argument is about the **publisher**, where `drawImage`,
`new VideoFrame(...)` and `captureStream()` all read the bitmap and a transform reaches none of them.
Here the only consumer is an eye.

Three things follow from the choice, and all three are deliberate:

- **The lens correction is dropped.** A radial distortion is not projective, so no 3×3 and no CSS can
  carry it. On an uncalibrated camera — `lensK1` zero, which is the default — the transform is exact;
  from there the error grows with the slider, reaching about a tenth of the board's radius at the
  maximum. `tests/unit/vision-geometry.test.ts` measures it rather than assuming it. This is a
  picture to look at: it scores nothing, and nobody throws at it.
- **Outside the rim is cut away, not painted over.** The clip is a hole at the same radius the device
  masks at, so the virtual board shows through rather than a square of somebody's living room. Both
  ends read `NORMALIZED_RADII.boardOuter`, so they agree by construction. The clip lives on an
  untransformed ancestor, because `clip-path` resolves in an element's own coordinate space and a
  circle on the warped box would come out warped too.
- **A director's zoom is still a zoom.** A description is an answer about the feed's *resting*
  framing rather than about one frame's pixels, so a camera that is moving sends none and a viewer
  stays on the framing it already had. The zoomed picture then runs through that transform exactly as
  it runs through no transform at all — it fills the board and grows, which is what a camera moving
  in on a dart is supposed to look like. Describing every frame would be more literally true and
  quite wrong: each one would be placed on the quarter of the board it showed, so the picture would
  shrink into the dart instead of zooming into it.

No geometry, a transform that cannot be placed honestly, or a corner of the frame projecting behind
the camera, and nothing is applied: the feed is the stretched square it has always been, uncut. The
last of those is the one that needs a guard rather than a fallback — a browser handed a frame that
folds through its own vanishing line draws something torn rather than declining to.

The transform is written from a `requestAnimationFrame` loop rather than a React render. The shot is
still for most of a match and moves every frame for the half second of a director command, and
fifteen renders a second to carry a matrix is the cost `MediaDebugPanel` already refuses for decoder
counters. The loop's ordinary tick is a reference comparison and nothing else.

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

### Why a link carries no video track

Media uses two data channels and no WebRTC media tracks. Control is ordered/reliable. Encoded video is
unordered with no retransmission; a late frame is useless.

The reason is the encoder. It belongs to the **mesh**, not to a link: a scorer encodes once with
WebCodecs and fans the same chunk out to every accepted, writable recipient. A media track would
belong to one peer connection, so a phone with four viewers would run four encoders of the same
picture — which is the cost this design exists to avoid. Fanning out an already-encoded chunk costs a
send per recipient and nothing more.

Two things follow. Quality is settled once at the source from the deployment's `media.video` profile
rather than negotiated per viewer; and each recipient is judged separately, so one that cannot keep
up has frames dropped for it — `bufferedAmount` past the backlog limit means skip, never queue —
without holding the others back.

### Geometry travels with the frame

A frame may carry an optional fifty-two byte block saying **where the board is in it**: the
image→board homography, the lens coefficient, and the published square. Flag bit 1 of the video
header says whether it is there, and the payload's offset follows that flag rather than the message
length — which is what leaves bit 2 free for whoever needs it next.

The numbers are [`feedGeometry.ts`](../src/shared/vision/feedGeometry.ts)'s and the byte offsets are
[`frames.ts`](../src/client/media/frames.ts)'s, so the two have to be read together. Two conventions
matter to a reader: the matrix maps into **normalized board space**, the same `[0, 1]` a `Region`
uses, so a receiver never learns that board units exist; and what travels is the lens *coefficient*
rather than the slider position, because the wire carries optics and not a widget.

It exists so a receiver can rectify the board to front-facing — the warp the device deliberately does
not do, because that needs a per-pixel inverse map and a GPU the detection model is already using. A
viewer's is idle, and as it turns out does not even need to be asked: see
[Straightening it on the viewer](#straightening-it-on-the-viewer). `ReceiverStats.geometry` is where
that reads it.

**Sent on change, on every keyframe, and only while the camera is at rest.** A mounted camera
re-solves its homography only when the motion gate fires and holds one shot between director
commands, so most frames say nothing — and a frame that says nothing means *unchanged*, never
*gone*. Repeating it on keyframes is what lets a viewer who joined late, or who lost the frame
carrying the last change, catch up on the same frame it can start decoding from. A camera part-way
through a director command says nothing at all, deliberately: see
[Straightening it on the viewer](#straightening-it-on-the-viewer) for why a moving shot is not one a
viewer should be told about. The publisher forgets what it has said whenever its encoder is replaced,
which is what stops a description surviving a camera pause: that stops the encoder but keeps the feed
UUID, and the phone may have been moved in between.

One consequence worth knowing: a viewer arriving in the middle of a director command has nothing to
place the feed with until the camera settles, and shows it unstraightened until then.

It says where the board is, not **when** that was worked out. A homography is kept for the whole
camera session with no maximum age (see [vision.md](./vision.md#the-board-mask)), so a receiver can
be handed a description a phone has since been nudged out of, and cannot tell. That is deliberate for
now: the device is framing its own shot with the same matrix, so a receiver cannot do better than its
source, and a staleness policy belongs to whatever would act on one.

**Compatibility.** There is no protocol version handshake, and both peers are served the same build
by the same server, so a mismatch needs a stale cached tab. Such a receiver would read twenty-nine
bytes, ignore a flag bit it does not know, and hand the block to its decoder along with the picture;
it fails to sync, asks for keyframes, and shows nothing — which is the fallback every other video
failure in this document already has, and a reload fixes it. The other direction is correct by
construction: a clear flag bit means no block.

### ICE, and why video may simply not work

STUN only helps peers discover public addresses. `media.iceUrls` defaults to `["internal"]`, resolved by
the browser to the host it reached and `media.stunPort` (3478 by default) — the STUN server this
deployment carries itself, so making remote play work does not mean naming a third party. It needs
that UDP port reachable, which a reverse proxy will not arrange.

There is no TURN relay. Where two routers cannot be talked past, the connection is simply not made:
unconnectable NAT combinations fall back to the virtual board, the match plays normally, and nothing
waits on video that is never coming. Adding a relay would be the place to change that, and it is a
deliberate omission rather than an oversight.

## Contract boundaries

Media state lasts only as long as the in-memory match server. Server restart recovery and persistence,
TURN, and server participation in the media data plane are outside the contract. Two misbehaving peers
can keep their own connection alive after teardown, but the server will no longer authorize signaling
and no valid client carries it across the match boundary.

The E2E diagnostics are enabled only in a development/E2E build with `?e2e=1`. They expose live
identities, link states, ICE stats, source/feed state, socket replacement, and same-peer fault injection;
they are absent from production builds.
