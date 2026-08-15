# Media — peer connections between the devices in a match

The optional feature that lets the people in a match see something: a board, and eventually each
other. It is off in one place and on in one place, and where a peer connection cannot be made it is
simply unavailable rather than degraded.

**The media system carries stills and live board video to remote viewers of a match.**
Links come up between every pair that needs one, each with two datachannels; a camera photographs a
square of its board on request — which puts a picture of each dart under the dart slots — and holds
one standing live-video offer for the remote viewers its owner addressed. It encodes once, and only
while at least one of those viewers has accepted.

The player at that board is never sent their own video: they are already looking at the real thing.
In an online match, an opponent may accept the feed and see it in place of the read-only virtual
board during that player's turn. A spectator is offered both online players' feeds independently and
follows whoever is throwing among the feeds they accepted. A local match instead offers its one
shared board camera only to spectators, who keep that same picture across both players' turns. A
declined, missing or frozen feed simply uncovers the virtual board underneath. Dart evidence uses
stills addressed to every role.

---

## The shape of it

```
scoring device ──┐                          ┌── scoring device
                 ├─ frontend ─── frontend ──┤
                 │       ╲       ╱          │
                 └────────╳─────╳───────────┘
                       (spectators watch, and never publish)
```

Five kinds of pair, in the order the server prefers them. Nothing else is ever paired — never two
scoring devices, never two spectators. A scoring device appears at all only when
[both gates](#the-two-gates-on-a-board-camera) are open.

| # | Pair |
| --- | --- |
| 1 | a scoring device and its own owner |
| 2 | the two participants |
| 3 | a scoring device and the opponent |
| 4 | a spectator and a participant |
| 5 | a spectator and a scoring device |

## The two gates on a board camera

A scoring device is offered to anybody only when **both** of these hold, and they belong to
different people on purpose:

| | Who decides | Where |
| --- | --- | --- |
| **The phone is willing** | the device itself, in its own settings: `disabled`, `stills` or `video` | *Share this view* on the scoring device |
| **The owner has nominated it** | the frontend that claimed it — exactly one device, or none | the device panel in the top bar |

So a phone can be permanently opted in without being permanently watchable, and an owner can take
the opponent's view away without touching a setting on a phone in another room. Neither side can
overrule the other: nominating a device that declined achieves nothing, and a willing device that
nobody nominated is in no roster at all.

**One nomination, one picture.** It is the owner's board offered to opponents and spectators;
nominating nothing is a complete opt-out they cannot work around.

`stills` and `video` do not differ in what the server allows: both open the same link with the same
two channels. The distinction is what a viewer should expect and ask for. Only `disabled` is a rule.

## Which way media flows

Two rules, each stated from both ends of every pair so the two sides can never disagree:

- **a spectator** watches and never sends;
- **a scoring device** is the mirror image — it is a board camera, so it sends and never receives. It
  has no business decoding anybody's picture, and saying so keeps a decoder off a phone that is
  already running a detection model.

Between two frontends it stays symmetric: either may grow a player camera later.

Both rules are about *media*. The control channel is open in both directions regardless, or a viewer
could not ask a camera for a keyframe or a still.

## Asking a camera for a picture

A **still request** names a square of a board and gets a photograph of it back. Dart evidence is the
first thing built on it and deliberately not the last: the protocol is "a region of a board, on
demand", and it knows nothing about darts.

### A region

```ts
interface Region { cx: number; cy: number; size: number }   // normalized [0,1], board space
```

**Board space**, so a request says *what to look at* and never *where to point*. The same region
means the same thing from any camera, and the asking side needs to know nothing about lenses, mounts
or angles. `{0.5, 0.5, 1}` is the whole board and is what an absent region means; dart evidence is
`(dart.x / BOARD_MAX, dart.y / BOARD_MAX, 0.25)`.

**The capturing device is the authority on what is valid**, and runs `clampRegion` over anything that
arrives however friendly the sender looked. A region that would fall off the edge has its centre
*moved towards the middle* rather than being rejected or shrunk — a dart in the 20 bed is near the
top, and the useful answer is the closest square that still holds it. So `{0.5, 1, 1}` becomes
`{0.5, 0.5, 1}`.

### From board space to pixels

The one place in the app where the geometry runs backwards
([`stillCapture.ts`](../src/client/vision/stillCapture.ts)):

```
board point ──(inverse homography)──▶ undistorted normalized
             ──(distortNormalizedPoint)──▶ normalized frame
             ──(the model's centre-square crop)──▶ video pixels
```

The forward trip is what the pipeline does on every inference; only the inverse is new. The region's
four corners are mapped and the **bounding square** is cut out — a board seen at an angle is not a
rectangle, and the dart then looks the way the camera saw it, which is what makes it evidence rather
than a diagram.

**The device keeps the last homography it solved**, because a mounted camera stands still: a frame in
which the board happens not to resolve does not cost the evidence. It is dropped when the camera
stops, so it can never outlive the session that produced it.

### What a capture costs

One `drawImage` with a source rectangle — crop and scale in a single operation, straight into a
canvas that is already the still's size — and then the JPEG. The canvas and its context are **made
once and kept**, like the preprocessing canvas in `model.ts`; a capture allocates nothing but the
picture it returns. A burst of three darts shares them.

Measured in the e2e container at the default sizes: **under 1ms to draw, 1ms to encode, 7–17ms
round trip** for a ~14.5kB still, the first of a run being the quick one — the two behind it wait
their turn in the queue.

The capture draws on the **CPU** (`DRAW_ON_CPU` in
[`stillCapture.ts`](../src/client/vision/stillCapture.ts)), which measured marginally slower and is
right anyway: at a twenty-millisecond round trip nobody can feel those milliseconds, and the scarce
resource on a scoring device is the GPU the detection model is using, not them. The diagnostics panel
shows `capture · wait/draw/encode` on a real device if that ever needs revisiting, and the **spread
matters more than the median** — a readback stalling behind the model is an occasional slow capture,
not a uniformly slow one.

### On the wire

All of it on the **control channel** — reliable and ordered, because an image that arrives in pieces
is not an image. This is the first traffic that flows *towards* a scoring device, which is why
`send`/`recv` are documented as being about media only.

| Message | |
| --- | --- |
| `still_request` | `{ id, region?, tag?, to }` — `to` is the [audience](#addressing-a-camera) |
| `still` | `{ id, tag?, width, height, mime }` **and the JPEG bytes, in the same message** |
| `still_refused` | `{ id, reason }` — `no_frame`, `not_located` or `busy` |

A still is one self-describing binary message: `[uint32 headerLength][JSON][bytes]`. A header sent
separately and paired with "whatever binary arrives next" stops working the moment two are in
flight, and a fused report committing three darts at once puts three requests in the air together.
That is rare rather than routine — but it is a thing the protocol has to survive, not an attack, and
`MAX_PENDING_STILLS` (four) is sized so a camera answers it rather than refusing.

`id` is the requester's, echoed back, so an answer is matched to its own request. `tag` is an opaque
value the device echoes without interpreting — dart evidence puts `{ dart: <index> }` in it, and that
is what lets an **observer**, who never sent a request and has no id to match, place the picture under
the right slot.

### Who may ask, and who receives

**Only the owner asks.** A camera honours a request from the peer its roster marks
[`own`](#the-two-gates-on-a-board-camera) and from nobody else; anyone else gets silence rather than a
refusal, since a peer with no business asking learns nothing from an answer.

**The addressed receive** — see [Addressing a camera](#addressing-a-camera). Dart evidence addresses
all three roles, and that is not laziness: one capture, one encode, the identical bytes written to
every open link is what keeps the camera the single account of what its board looks like, so an
observer's copy of what a dart did cannot drift from the thrower's.

Together those two make observers exactly what they should be: they see what the owner's camera was
asked to show them, and have no say in what that is.

A still rides the **control** channel, so it is reliable and ordered — an image that arrives in
pieces is not an image. It is also the only control message with real weight, which is why
`sendControl` guards its size the way `sendMedia` does: `send` throws over the negotiated limit, and
that throw would come out of the middle of the fan-out loop. A link that will not take a still goes
without one; the rest of the loop still runs.

## Addressing a camera

`still_request` and `video_start` both carry `to` — the kinds of viewer the result is for. Command
authority and result audience are independent: only the owner commands the camera.

| Role | |
| --- | --- |
| `owner` | The frontend that claimed this device. The only peer that may command it. |
| `opponent` | Somebody else playing the match. |
| `spectator` | Somebody watching it. |

The role is on every roster entry, and it is **the one thing in a roster a client could not work out
for itself**: `own` separates the owner from everybody else, but nothing else distinguishes an
opponent from somebody who is only watching. So the server computes it, in the same pass and from the
same plan as everything else, and the two ends cannot disagree about it.

`role === 'owner'` is exactly `own`, by construction. They are two fields because they answer
different questions and only one is an authorization check: `own` decides who may command, `role`
decides who a result is for. Tying the first to the second would mean that renaming or adding an
audience silently moved a permission.

### It fails closed

[`clampAudience`](../src/shared/media.ts) is the twin of `clampRegion`, and follows the same rule —
**the device is the authority** and runs it over whatever arrives. Unknown entries are dropped,
duplicates collapse, and a list that is missing, empty or nothing but nonsense becomes `['owner']`:
the peer that asked, and nobody else.

Not "everybody", which is the tempting default and the one this exists to stop being automatic. A
sender that gets this wrong should be able to cost a picture and should never be able to put a live
board in front of a stranger watching the match. The worst case is then a feature that quietly does
less, which is recoverable, rather than one that quietly does more, which is not.

Because failing closed must not mean failing *quietly*, a camera records the audience of every still
it takes ([`StillTiming`](../src/client/hooks/useStillResponder.ts)), and the diagnostics panel shows
the roles offered live video and the exact peers that accepted.

### What each caller asks for

| Caller | Audience | |
| --- | --- | --- |
| Dart evidence | all three | An observer's copy must not drift from the thrower's. |
| Online match video | `['opponent', 'spectator']` | The owner is at the physical board and receives no copy. |
| Local match video | `['spectator']` | Both local players share the owner's physical board; only remote spectators need its picture. |

## Live board video

An owner frontend sends `video_start` when a match begins and `video_stop` when it finishes or is
left. Online matches address `opponent` and `spectator`; local matches address only `spectator`. The
camera creates a UUID for that standing offer and sends `video_offer` only to roster peers whose
server-assigned role is in that audience. Each recipient accepts or declines that UUID independently.
No frame is encoded until the first acceptance, and the final decline or disconnect stops the encoder
without ending the offer.

Choices live only for that UUID. A recipient is prompted once, may change the choice later with the
board controls, and is prompted again for a replacement feed. Participants keep an accepted
opponent feed decoding across turns but display it only on the opponent's turn. Online spectators
keep both accepted feeds decoding and display the current player's; local spectators keep the one
shared feed displayed across every turn. Links may be negotiated in the lobby, but no offer exists
there or on the finished-match summary.

The receiver waits for an actually decoded frame from the accepted UUID before showing anything. A
decline, a missing or failed link, a tier below `video`, an unsupported decoder, or three seconds
without a decoded frame keeps or restores the virtual board. The next matching decoded frame restores
the live picture immediately. This failure path is ordinary because STUN without TURN cannot connect
every pair of home networks.

The local match frontend starts and directs its one shared camera but addresses the offer only to
`spectator`; its own board remains the ordinary input UI. Because a local camera has no single
`playerId`, a spectator displays that accepted feed for either player's turn. [Dart evidence](#asking-a-camera-for-a-picture)
independently requests one still photograph per dart.

The owner commands the camera; offer recipients command only their own delivery:

| Message | |
| --- | --- |
| `video_start` | `{ to }` — publish, to these roles. **No region** — starting a feed and framing it are different decisions. |
| `video_stop` | Ends the feed, for everybody. No roles: "stop sending to spectators" is a shorter `video_start`. |
| `video_region` | `{ region, transitionMs?, resetMs? }` — the **director**: the same square vocabulary a still uses, plus how long to take getting there and how long to stay. |
| `video_offer` | `{ feedId }` — this source is offering this UUID to this eligible peer. Idempotent when repeated. |
| `video_accept` / `video_decline` | `{ feedId }` — this exact peer changes its choice for this exact offer. No acknowledgement. |
| `video_end` | `{ feedId }` — the standing offer is gone for this peer. Sent once. |
| `keyframe` | `{ feedId }` — an accepted viewer cannot decode forward. |

`video_start`, `video_stop`, and `video_region` are owner-only, enforced exactly where a still request
is. [`useVideoResponder`](../src/client/hooks/useVideoResponder.ts) accepts a viewer choice only when
the UUID is active and that exact `peerId` is currently in `mesh.viewers(ownerAudience)`. Every frame
intersects the accepted peer IDs with the same current roster answer. A guessed UUID or a command
from an unaddressed role is ignored in silence.

**A camera holds one offer.** A second `video_start` re-addresses the same UUID rather than opening
another. Peers removed from the audience receive `video_end`; newly eligible peers receive the offer;
unchanged acceptances survive. Adding an accepted viewer asks the running encoder for a keyframe but
does not restart it.

**The offer outlives a camera restart.** Switching the scorer camera off stops the encoder and lets
accepted viewers fall back after three seconds. Switching it on resumes the same UUID and choices.
Finishing or leaving the match, changing the media tier, opting the frontend out, removing the board
nomination, or losing ownership ends it.

### A shot expires; a move does not happen unless asked for

The two optional numbers on `video_region` default in opposite directions, and
[`directorTiming`](../src/shared/media.ts) is where both ends agree what they mean.

| Left out | Means | Because |
| --- | --- | --- |
| `transitionMs` | **`media.virtualCamera.transitionMs` (0 — cut)** | Saying nothing about how to move means do not move. A director who wants a move asks for one. |
| `resetMs` | **`media.virtualCamera.resetMs` (2000 — come back)** | Saying nothing about how long to stay does *not* mean stay forever. |

A director command is **fire-and-forget**. Nothing guarantees another one is coming, and a camera left
zoomed into the 20 bed because the message that would have released it was never sent is worse than
any framing. So a shot expires on its own, and `resetMs: 0` is how a caller that *will* send the
release says so.

Both fallbacks live in `media.virtualCamera` and are read by the **device**, which is the authority
on its own camera, so they travel in `app_config` like every other shared number — `directorTiming`
takes them as an argument rather than reaching for them, since the module it lives in is shared with
a server that has no config to consult. A deployment may move either, but not the asymmetry between
them: one is about how a move looks, the other about not being stranded.

Dart evidence relies on neither. It sends both timings outright from `media.dartEvidence`, because
how long a dart is worth looking at is a question about darts — `virtualCamera` is the backstop for
callers with no opinion, and this one has two.

Three details that make it read as a camera rather than as a state machine:

- **The clock starts when the command lands**, not when the move finishes. A 500ms move with the
  default reset is half a second in, a second and a half held, half a second back.
- **The reset takes the same `transitionMs` back out.** A shot that eased in and snapped out reads as
  a glitch.
- **A new command interrupts whatever is in flight**, including a reset, and departs from *where the
  shot currently is* rather than restarting from where the interrupted move began. The pending reset
  is cancelled with it.

Dart evidence is the shape this was designed around: it asks for a 500ms move per dart and never
sends a release, because there is nothing in a visit that would know to.

### `keyframe` is the one command anyone may send

Every other command is the owner's. This one is not, deliberately: a viewer asking for a keyframe is
saying *"I cannot decode what you are sending"*, which is a statement about them and changes nothing
about what is shown. Refusing it would leave an opponent staring at a broken picture with no way to
say so.

What stops it being an amplifier is a rate limit rather than a permission check — several viewers
losing the same frame all ask at once, and a keyframe costs *every* viewer bandwidth, so one answer
serves all of them (`VIDEO.keyframeMinIntervalMs`).

**The limit is on the answer, not on the question.** Asking is free; producing is rationed. A limit on
asking cannot tell a request that crossed a keyframe already in flight — already granted — from one
that arrived just after a keyframe failed to go out, and it answers the first while ignoring the
second. Which is exactly backwards.

### The virtual camera

There is no second lens and no zoom motor. A shot is the source rectangle of a `drawImage` — the same
primitive a still uses — and a camera move is those four numbers interpolated between where they were
and where they are going. [`videoCamera.ts`](../src/client/vision/videoCamera.ts) is an easing
function and a lerp.

**Not CSS, which cannot work.** A transform on a `<canvas>` or `<video>` changes only how the browser
composites that *element* into the page, never the bitmap — and `drawImage`, `new VideoFrame(canvas)`
and `captureStream()` all read the bitmap. An encoder fed from any of them would receive the
untransformed picture. Nothing rasterizes a CSS-transformed subtree at fifteen frames a second.

Two details worth keeping:

- **The destination is re-resolved every frame**, not snapshotted when the command arrives. That is
  what lets a feed start before the board has been located, showing the camera's own centre square,
  and *slide onto the board* the moment a homography exists — with no state machine and nothing to
  notify. An un-directed shot means the whole board; the camera's square is the fallback, not the
  default.
- **Interpolated by centre and size**, not corner and size. The two agree only when the sizes match:
  lerping a corner through a pure zoom slides the picture sideways as it shrinks.

Its canvas is its own, and pointedly *not* the still canvas — that one asks for `willReadFrequently`
because `toBlob` reads it straight back, and this one is handed to `new VideoFrame(...)`, which wants
the pixels where the encoder is.

### One encoder, however many viewers

[`videoPublisher.ts`](../src/client/media/videoPublisher.ts) owns the single `VideoEncoder` and writes
its output to the accepted peer IDs inside `mesh.viewers(ownerAudience)`. The encoder does not exist
until the first acceptance and is stopped after the last one leaves. This is what [Why a link carries
no video track](#why-a-link-carries-no-video-track) enables.

- `latencyMode: 'realtime'` and `avc: { format: 'annexb' }`. Annex B puts SPS/PPS in front of every
  keyframe, so a keyframe is everything a decoder needs to start — which is what lets a viewer who
  joined thirty seconds late begin on the next one with nothing negotiated out of band.
- Paced by `requestVideoFrameCallback` where it exists, and throttled to the profile's rate either
  way: a camera handing back thirty frames a second is not encoded at thirty.
- **Drop, never queue.** A link more than `VIDEO.maxBufferedMs` behind is skipped for that frame —
  judged per viewer, so one slow peer does not cost the others. A quarter-second, expressed as a
  duration and converted to bytes against the profile the deployment actually ships: the same rule
  written as a flat 16KB is a quarter-second at 500kbps and *less than one frame* at 5Mbps, where it
  would throw away frames the link could carry.
- **A keyframe counts from the moment it is on a wire**, not from the moment it was encoded. Both of
  the rules above can throw one away, and a keyframe nobody could take has repaired nothing; counting
  the attempt would satisfy the schedule with a frame that never went. The publisher keeps the two
  clocks apart — when one last *went out*, which drives the schedule, and when one was last *asked
  of the encoder*, which bounds the retry.

The failure this shape exists to prevent is quiet, and it is what a still scene provokes: nothing
moves, delta frames cost almost nothing, and the encoder spends a whole banked second of bitrate on
the next keyframe. If that keyframe is over what the link will carry it is thrown away — and so is
the next, for the same reason, forever. Nobody is disconnected and no frames stop arriving; the
picture simply drifts further from the board with every delta and never gets pulled back. Hence
`oversize` counted apart from `dropped` in the panel, and hence a link's message limit being
[read from the connection](../src/client/media/peerLink.ts) rather than assumed to be the 64KB floor —
Chrome negotiates 256KB, and the difference is precisely where those keyframes live.

### A frame on the media channel

Twenty-nine fixed bytes rather than the JSON a still carries, because this is the channel with a bitrate
budget:

```
byte 0      u8   flags — bit 0 set for a keyframe
bytes 1–4   u32  seq
bytes 5–12  f64  timestamp, microseconds
bytes 13–28 feed UUID
```

The timestamp is a float64 rather than a `u32` of microseconds, which would wrap after seventy-one
minutes — a length of time a match can exceed.

The UUID prevents an in-flight frame from an ended feed being decoded as part of a later offer from
the same peer. `seq` is what makes an unreliable, unordered channel usable. A decoder handed a delta frame whose
predecessor never arrived does not produce a late picture; it produces a wrong one, and keeps
producing wrong ones until the next keyframe. So [`videoReceiver.ts`](../src/client/media/videoReceiver.ts)
drops rather than hopes: nothing until a keyframe, nothing at or behind what it has already decoded,
and nothing after a gap — asking for a keyframe rather than waiting for the next scheduled one.

## The roster is the authorization

The server computes, for each peer, the set of peers it may talk to; publishes exactly that; and
relays a signal only between two peers that appear in each other's roster. There is no other rule —
no room token, no join secret — because there is nothing else to check. A peer either is somewhere
the server put it, or it is not.

Three properties follow from computing both endpoints from **one plan**
([`planFor`](../src/server/media.ts)), rather than answering the question per peer:

- two peers can never disagree about whether they are paired, which of them is polite, or who may
  send to whom;
- the caps are enforced while the pair list is being built, so a peer at its limit is never offered
  a link the other end has not heard of;
- a roster is recomputed when a signal arrives, never remembered, which closes the window on a
  message that was already in flight when somebody walked out.

The roster is authoritative in **both** directions. A peer that has vanished from it is a link that
closes, and that is the only teardown mechanism in the feature: leaving a match, a match closing, a
phone dropping off the Wi-Fi and a browser opting out all arrive at the client as the same event, a
name missing from a list. There is no goodbye message anywhere in this protocol.

### Rooms

A **room** is a lobby before the match and the match after — one space, because they are one thing at
two moments. A scoring device has no room of its own; it inherits its owner's, which is what makes a
device visible to the opponent exactly when its owner is.

Nothing about a room is stored. It is derived from the client registry on demand, the same way
`resolveScoringTarget` and `devicesScoringInto` already are. The server's entire media state is four
small maps — peer ids, tiers, board-camera nominations, and what each peer was last told — every one
of them keyed by a live socket or a live session and gone when it goes. A client re-states its tier
and its nomination on each connect, exactly as it re-states its device claims.

That is what makes a re-match free: a new match id holding the same people produces an identical
roster, so nothing is sent and no link is disturbed.

## The wire

Three messages up, three down. `media_` is the one prefix both a frontend and a scoring device may
speak — the routing guard in [`wsHandler.ts`](../src/server/wsHandler.ts) still keeps a device out of
every gameplay handler.

| Direction | Message | |
| --- | --- | --- |
| → | `media_ready` | take part, at a stated `MediaTier`. Sent again whenever the tier changes |
| → | `media_leave` | stop taking part |
| → | `media_select_camera` | `{ deviceId \| null }` — a frontend nominating one of its own claimed devices as the board camera |
| → | `media_signal` | `{ to, description }` |
| ← | `app_config` | how the deployment is tuned, sent on connect beside `mode_catalog` |
| ← | `media_peers` | `{ self, peers }` — a retained topic, pushed on every change |
| ← | `media_signal` | `{ from, description }` |

**There is no candidate message.** A description is not sent until ICE gathering has finished, so it
already carries every candidate. A link has no tracks, so its SDP is written once and never changes:
a link's entire signaling life is one offer and one answer.

The server never parses SDP. It checks that a description is an offer or an answer and that it is
under `MAX_SDP_BYTES`, and relays an opaque blob between two peers it paired itself.

## Why a link carries no video track

Every `RTCPeerConnection` encodes its tracks independently. A scoring device with four viewers would
run four encoders, on a phone that is already running the detection model on its GPU.

So media does not go through WebRTC's media pipeline at all. A link is pure transport, and one
WebCodecs `VideoEncoder` — owned by the **mesh**, not by a link — writes the same encoded chunks to
every open media channel. One encode, however many viewers, and a fixed `VideoEncoderConfig` instead
of asking `setParameters` nicely for a bitrate.

The pairing that suggests itself instead, WebCodecs plus WebRTC Encoded Transform, does not work:
Encoded Transform inserts a transform *after* the codec, so supplying our own bitstream through it
would mean running the browser's encoder too and discarding its output.

[`media-codec.spec.ts`](../tests/e2e/media-codec.spec.ts) is what holds this premise honest — it
encodes, ships and decodes over a real link, and it exists to fail loudly if the bet is wrong.

### What that costs

NACK, FEC, PLI and bandwidth estimation. The last is moot: adaptive bitrate is deliberately not a
feature, and the honest policy for a fixed-rate link is *drop frames, never queue*. The rest is ours
to write, and the two channels are shaped for it:

| Channel | Config | Carries |
| --- | --- | --- |
| `control` | reliable, ordered | link control, keyframe requests, stills |
| `media` | `ordered: false, maxRetransmits: 0` | encoded video |

An unreliable channel drops a whole SCTP message rather than delivering half of one, so one frame per
message means a loss is a missing frame and never a corrupt one.

**The escape hatch is deliberate.** [`peerLink.ts`](../src/client/media/peerLink.ts) keeps full
perfect-negotiation renegotiation although nothing triggers it, because that is what a video track
would need if WebCodecs disappoints on a real phone.

## Turning it off

Three independent answers, and all three have to be yes.

| Who | How | Default |
| --- | --- | --- |
| the deployment | `media.enabled: false` in the settings file ([`config.ts`](../src/server/config.ts)) | on |
| a browser | the switch in the top bar's device panel | on |
| a phone | *Share this view*, in the scoring device's settings — `disabled`, `stills` or `video` | `video` |

A client that has opted out never announces itself, so it appears in nobody's roster.

Distinct from all three, and not an opt-out: **which** board a frontend shows. Turning media off
stops this browser taking part at all, including watching the opponent; nominating no board camera
leaves everything else working and only stops anybody seeing *your* board.

## ICE, and why video may simply not work

```json
"media": { "iceUrls": ["internal"], "stunPort": 3478 }   // the defaults
```

Two devices behind different routers cannot guess each other's addresses. STUN is how each learns
the address its own router presents to the world — its **server-reflexive** candidate — so that it
has something to offer the other. Without it there are only host candidates: a scoring device
reaches its own frontend across the room, and an opponent in another house reaches nobody.

`iceUrls` decides both which servers clients are told about *and* whether this deployment runs one,
which is deliberate — the two cannot then disagree. Listing anything replaces the default, so
`internal` has to be listed again to keep it:

| `iceUrls` | what runs, what clients get |
|---|---|
| `["internal"]` | the default: our own server, and nobody else's |
| `["internal", "stun:…"]` | both, ours first — order is kept |
| `["stun:…"]` | theirs only; nothing is started here |
| `[]` | neither: host candidates only |

**Carrying our own** is the reason this exists. The alternative is naming a public STUN server, in
practice Google's, which hands the address of every player to a third party to make an optional
feature work. [`stun.ts`](../src/server/stun.ts) is about a hundred lines and no dependency, because
plain STUN is one question and one answer.

**The server never learns its own address.** It cannot, reliably — its own interfaces show a LAN
address from behind a NAT, and a `Host` header is whatever a proxy chose to pass on. So `internal`
travels to the client as the word `internal`, and [`appConfig.ts`](../src/client/lib/appConfig.ts)
turns it into `stun:<location.hostname>:<stunPort>` on arrival. The browser is holding a hostname
that demonstrably reaches the server, because it just used it.

### What it needs, and what it does not fix

The STUN port must be reachable **as UDP**, which is the one part of a deployment a reverse proxy
does not arrange: proxies forward TCP. nginx can do it from a `stream {}` block with `listen … udp`;
Caddy does not proxy UDP at all. In practice it means a firewall rule straight to this machine.

On a single network the server answers with the address the device already had, and ICE discards the
redundant candidate (RFC 8445 §5.1.3) — harmless, and pointless, which is the right way round for
something that is on by default.

There is still **no TURN and no fallback**. Where a peer connection cannot be made the feature is
unavailable to that user, and the interface must treat that as ordinary rather than as an error:
symmetric NAT at both ends defeats STUN too.

### When the port is blocked

Nothing fails and nothing is reported. Gathering falls back to host candidates, a link on one network
comes up as it always did, and the only symptom is **delay**: descriptions are not sent until
gathering finishes ([`peerLink.ts`](../src/client/media/peerLink.ts)), so every link waits out
`GATHER_TIMEOUT_MS` — two seconds — before offering what it has. Chrome does not raise
`icecandidateerror` for a server that merely never answers; it keeps waiting, and gathering never
completes at all.

A bind that fails is the half we can be loud about: the server says so on startup and then drops
`internal` from what it advertises, so no client is ever pointed at a port with nothing behind it.
For the other half, the diagnostics panel carries whatever ICE did report — see
[Reading a real link](#reading-a-real-link).

## Capacity

Both live in [`capacity.ts`](../src/server/capacity.ts) and are reported by `/server-stats`. Neither
is derived from `MAX_MATCHES`, because neither is about the server: they bound what one phone is
asked to do.

- `MEDIA_PEERS_PER_PEER` (6) — most links one peer is offered. Refused; the priority order decides
  which pairs survive, so what is lost is always the least valuable link. In practice it almost never
  binds: with one board camera per user, a frontend's worst case is the opponent, two boards and two
  spectators. It is a backstop against a shape we do not currently have rather than a live limit.
- `MEDIA_VIEWERS_PER_ROOM` (2) — spectators admitted per room. An audience is uncapped per match by
  design, and every extra viewer is another link on a player's phone.

## Where the code is

```
src/shared/config.ts         the tuned numbers: still size, video size/rate/bitrate, dart evidence
src/shared/media.ts          peers, rosters, roles and audiences, the channel names, video policy
src/server/media.ts          the peer map, the plan, the roster, the relay
src/server/stun.ts           one UDP socket: what address do you see me at
src/client/media/peerLink.ts one RTCPeerConnection: perfect negotiation, half-trickle, two channels
src/client/media/mesh.ts     the set of links, and who counts as a viewer
src/client/media/frames.ts   how bytes are framed on each channel — both formats
src/client/media/videoPublisher.ts  one VideoEncoder, paced and fanned out
src/client/media/videoReceiver.ts   one VideoDecoder per publisher, and the loss rules
src/client/vision/stillCapture.ts   a board region → a crop of this camera's frame → a JPEG
src/client/vision/videoCamera.ts    the same crop, animated: the virtual camera
src/client/hooks/useMediaMesh.ts     mounted by App and ScorerApp alike
src/client/hooks/useStillResponder.ts  the camera's side: who may ask, and who gets the answer
src/client/hooks/useVideoResponder.ts  offers, authorization, choices and encoder lifecycle
src/client/hooks/useVideoFeed.ts       consent, receivers, fallback, selection and direction
src/client/hooks/useDartEvidence.ts    the only place that knows what a still is *for*
```

## Reading a real link

The diagnostics panel is dev-only, behind the [`e2eEnabled()`](../src/client/lib/e2e.ts) seam: open
`/?e2e=1` or `/scorer?e2e=1` and it appears bottom-left. This gate affects diagnostics only, never
whether a production match starts or displays video.

It exists because headless Chromium cannot answer the question that decides whether this feature
works — whether a phone on your Wi-Fi reaches your laptop, and whether two households reach each
other with no TURN. The candidate pair is what to read: `host` means the two ends were on one
network, `srflx` means they found each other through a NAT.

Two things about ICE are worth knowing where to find. The header counts the configured servers, and
hovering it lists them — `internal` has been resolved against this page's own host by then, so this
is the only place to see what it became, or that it was dropped because the server had nothing
listening. And a link that reports `ice …` was told by an ICE server that answered and refused — which is *not*
the unreachable case, since a server that never answers raises nothing. That one shows up as a link
that took two seconds to negotiate, and nothing else.

> **A trap worth knowing about.** Chrome hides local IPs behind `.local` mDNS names in ICE
> candidates, and mDNS does not resolve in a headless container, so two browser contexts cannot find
> each other and the failure looks exactly like a bug in this code.
> `playwright.config.ts` passes `--disable-features=WebRtcHideLocalIpsWithMdns` for that reason.

The panel reports link/ICE data, the source offer UUID, roles and accepted peers, encoder counters,
recipient choices, receiver counters, and still timings. It deliberately does not duplicate the
production picture. `window.__media.frame()` reads the raw receiver canvas for automated diagnostics.
The match screen mounts the selected current-player canvas directly in the board area.

## What is not built

The framework leaves these future uses expressible and takes no position on them.

- **Anything but a board camera publishing** — the mesh is symmetric and a frontend could publish a
  face; none does.
- **Which link to open when** — the mesh connects to every peer it is offered. Note this is a smaller
  question than it was: *which board is watchable at all* is settled by the two gates above, on the
  server, and is not the client's to decide.
- **A camera the owner can point by hand.** Director commands exist and are wired to dart evidence;
  no interface issues one.

## Known limitations

- **A socket reconnect rebuilds every link** (a few seconds of nothing). New socket, new peer id —
  the price of the server holding nothing across one. Most visible after a *server* restart, where
  the peer connections were perfectly healthy and are torn down anyway.
- **No board video while the camera is off.** Media reads the vision runtime's camera and never
  starts one, so the two-minute camera-off stage ends the board view and standby ends everything.
  Between legs there is nothing to watch. See [the two power stages](./glossary.md#scoring-and-the-two-power-stages).
- **Encoding once does not make decoding free.** A spectator receiving both players' boards runs two
  decoders even though only the current player's canvas is displayed.
