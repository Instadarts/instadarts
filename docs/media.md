# Media — peer connections between the devices in a match

The optional feature that lets the people in a match see something: a board, and eventually each
other. It is off in one place and on in one place, and where a peer connection cannot be made it is
simply unavailable rather than degraded.

**What exists today is the transport, stills on top of it, and live board video behind the `?e2e=1`
seam.** Links come up between every pair that needs one, each with two datachannels; a camera will
photograph a square of its board on request — which is what puts a picture of each dart under the
dart slots — and it will also publish a live feed of a square it is *told* to look at, from one
encoder to however many viewers. Both say who they are for: a command carries an
[audience](#addressing-a-camera).

**Only the first of those two has a user.** Dart evidence is shipped, and photographing darts is the
whole of what a board camera does in a production build. Everything about the live feed — asking for
one, pointing it, watching it, [recording a clip](#recording-a-clip) of it and the match overlay drawn
over that — lives inside the diagnostics panel and is unreachable without the seam, because it has not
been proven on real phones. It is documented at full length below anyway: the pipeline is real and
finished, and the gate is the only thing between it and a board on the match screen. See the warning
under [Live board video](#live-board-video) for where each gate sits, and
[What is not built](#what-is-not-built) for what is missing.

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

**One nomination, one picture.** What the owner watches is exactly what the opponent is offered, so
nobody has to wonder which board they are looking at — and nominating nothing is a complete opt-out
the opponent cannot work around.

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

`still_request` and `video_start` both carry `to` — the kinds of viewer the result is for. Who may
*command* has not changed; what is new is that a command says who the answer is for.

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
the audience its feed is currently addressed to.

### What each caller asks for

| Caller | Audience | |
| --- | --- | --- |
| Dart evidence | all three | An observer's copy must not drift from the thrower's. |
| The lobby video feed | `['owner']` | ⏳ a thing being proven, not a thing being shown. |

## Live board video

> ⚠️ **The transmission system is finished; nothing in the product invokes it.** Not a prototype and
> not a sketch — encoder, fan-out, decoder, the commands and the virtual camera all work end to end,
> and the only caller they have is the diagnostics panel. So this section describes a built thing, and
> what follows is where its single gate sits.
>
> Everything on the frontend's side of the feed is behind [`e2eEnabled()`](../src/client/lib/e2e.ts),
> which needs a dev or `VITE_E2E` build **and** `?e2e=1` in the URL:
>
> | | where the gate is |
> | --- | --- |
> | Asking for a feed — `video_start`, `video_stop` | `useVideoFeed`, `asking` |
> | **Directing it** — `video_region` | `useVideoFeed.direct`, which returns early. So dart evidence's per-dart camera move, described below as though it happens, does not happen in a shipped build. |
> | Rendering one | `MediaDebugPanel` → `FeedView`, the only place `feed.canvases` is read anywhere |
> | [Recording a clip](#recording-a-clip), and the match overlay drawn on it | the same component |
> | `window.__media` | the same gate |
>
> **The device's half is not gated and is live in production.** A phone whose tier is `video` will
> encode and publish to whoever is entitled the moment it is asked. Nothing ever asks it.
>
> **Stills are not in this category.** [Dart evidence](#asking-a-camera-for-a-picture) is a shipped
> feature and the only thing a board camera is actually used for today — `useDartEvidence` requests a
> photograph per dart unconditionally, and only its timing measurements are behind the seam.
>
> The code ships either way: `e2eEnabled()` compiles to a constant `false`, so the panel, the recorder
> and the overlay are all present in `dist` and unreachable rather than absent from it.

Three commands, and the split between the first two and the third is the point:

| Message | |
| --- | --- |
| `video_start` | `{ to }` — publish, to these roles. **No region** — starting a feed and framing it are different decisions. |
| `video_stop` | Ends the feed, for everybody. No roles: "stop sending to spectators" is a shorter `video_start`. |
| `video_region` | `{ region, transitionMs?, resetMs? }` — the **director**: the same square vocabulary a still uses, plus how long to take getting there and how long to stay. |
| `video_state` | `{ on, reason? }` — told to every viewer, not only to whoever asked. |

Owner-only, enforced exactly where a still request is: [`useVideoResponder`](../src/client/hooks/useVideoResponder.ts)
drops anything from a peer the roster does not mark `own`, in silence.

**A camera publishes one feed.** So a second `video_start` does not open another one — it
re-addresses the one that is running, which is the only way an audience is widened or narrowed. The
encoder is untouched by it: the audience is read on every frame rather than captured when the
publisher is built, because tearing down an encoder to change a recipient list would cost every
viewer a gap and a keyframe, including the ones whose membership never changed.

`video_state` exists because a spectator never sent a command and would otherwise have no way to tell
a feed that is off from a link that is broken — both are a black rectangle. Addressing adds a third
thing to be unable to tell apart: a feed that is running *for somebody else*. So the announcement is
split, and an unaddressed viewer is told so rather than told `on` and shown nothing. Its `reason` is
one of `not_offered` (the phone's tier is not `video`), `no_camera`, `no_encoder` (a browser without
`VideoEncoder`; Safari before 16.4), or `not_addressed`.

**The owner's wish outlives the camera.** A feed asked for in the lobby starts when the camera does,
and survives the camera being switched off and on — the owner never withdrew the request and cannot
see that anything happened.

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
its output to `mesh.viewers()` — the same call a still's fan-out makes. This is what
[Why a link carries no video track](#why-a-link-carries-no-video-track) has been reserving space for.

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
  the rules above can throw one away, and a keyframe nobody could take has repaired nothing; recording
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

Thirteen fixed bytes rather than the JSON a still carries, because this is the channel with a bitrate
budget:

```
byte 0      u8   flags — bit 0 set for a keyframe
bytes 1–4   u32  seq
bytes 5–12  f64  timestamp, microseconds
```

The timestamp is a float64 rather than a `u32` of microseconds, which would wrap after seventy-one
minutes — a length of time a match can exceed.

`seq` is what makes an unreliable, unordered channel usable. A decoder handed a delta frame whose
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
src/client/hooks/useVideoResponder.ts  the camera's side of the feed, and the keyframe exception
src/client/hooks/useVideoFeed.ts       the frontend's: ask, watch, direct
src/client/hooks/useDartEvidence.ts    the only place that knows what a still is *for*
```

## Reading a real link

The diagnostics panel is dev-only, behind the same [`e2eEnabled()`](../src/client/lib/e2e.ts) seam as
the power-management overrides: open `/?e2e=1` or `/scorer?e2e=1` and it appears bottom-left.

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

### Recording a clip

⚠️ Panel-only, like everything else about the feed — see [Live board video](#live-board-video). It is
a debugging instrument for looking at what a real phone sent, not a feature anybody is offered.

Each feed in the panel has a **● rec** button. Press it, press it again, and the browser saves what
was on screen in between.

It is a re-encode of the decoded picture rather than a copy of the wire, which is the trade that
makes it play anywhere by double-clicking. Frames the decoder rejected are not in it; a stall shows
as a freeze, because a canvas capture repeats the last painted frame.

**MP4 is preferred, and not because it is the nicer format.** `MediaRecorder` writes its container as
it goes, without knowing how long the recording will turn out to be — and a WebM written that way
carries no Cues element and no Duration, so a player loads it, reports `duration: Infinity`, and
offers a scrubber that does nothing. It plays; you cannot move around in it. VLC and Chrome both
refuse. The fragmented MP4 the same recorder produces carries a real duration in its `moov`, and both
seek in it happily. Measured out of the e2e Chromium, three seconds each:

| | duration | seekable end | Cues |
| --- | --- | --- | --- |
| `video/webm;codecs=vp8` | `Infinity` | `Infinity` | none |
| `video/mp4;codecs=avc1` | `2.981633` | `2.981633` | — |

`avc1` is asked for explicitly because bare `video/mp4` produced VP9-in-MP4: playable, four times the
size for the same three seconds, and fussier about what will open it. WebM stays in the list as the
fallback for a browser with no MP4 recorder — Firefox — because an unseekable clip beats no clip. It
is simply not the one to prefer.

The e2e loads the saved file into a `<video>` and asserts its duration is finite, so a change that
reintroduced the unseekable container would fail rather than merely look fine.

**The clip carries the match on it.** A camera sends a picture of a board and nothing else — it does
not know whose throw it is or what the dart it just watched land was worth — so a clip of a raw feed
is a dartboard with no story attached. [`feedOverlay.ts`](../src/client/components/feedOverlay.ts)
draws the player and score along the top, the visit along the bottom, and flashes the visit as it
stands over the middle as each dart lands: three quarters opaque, growing out of the frame as it
fades, gone inside a second.

**The visit, not the dart.** 60, then 120, then 170 — the number somebody watching a clip back is
actually keeping. The dart's own label is already on the strip below, and repeating it enormously
across the board says nothing new. Three moments are not the total, and they are the three where the
total is not the news: a dart that scored nothing flashes "miss", a visit thrown away flashes the
mode's "Bust!", a leg won flashes its "Checkout!". The first two are red and the third is green, and
the strip along the bottom is coloured the same way — a dart worth nothing in red, the dart that
finished the leg in green, everything else white.

Both of the flash's curves are weighted towards the start, and that is the whole of the tuning. The
obvious shaping — ease the growth out, fade linearly — spends the motion budget immediately: the
label is past a readable size within a tenth of a second and half transparent by the midpoint, so a
second of animation holds barely a tenth of a second of legible label. Easing the growth *in* and
squaring the fade holds it near its starting size and near full opacity for two thirds of the
duration, then throws it off the screen. Same length, same shape, **665ms readable instead of
109ms**.

**Two canvases, and the reason matters.** The receiver's holds the decoded picture untouched; the
panel owns a second and composites picture-then-overlay onto it on every animation frame, and records
*that*. So the raw picture stays raw — `__media.frame()` and the fingerprints the director tests
compare see a board rather than a player's name across it — and the flash animates on its own clock
instead of only when a video frame happens to arrive.

The overlay is assembled in [`App.tsx`](../src/client/App.tsx), where the match is, by `overlayFor` —
the one piece of this that runs outside the gate, because it is one small object per render and a
branch to avoid building it would cost more to read than to compute. Nothing draws it unless the
panel is open. And it holds no rules. Every word and every colour is read off the mode's own `ModeView`, the same one
the match screen renders: the visit total it already puts under the board, the verdict it already puts
on a player's card. It knows a bust only in the sense that it can see the mode saying so — **a card
score carrying a tone at all is a verdict rather than a number**, and `danger` is the only tone that
means the visit came to nothing. The panel below it draws what it is handed and knows even less.

## What is not built

All ⏳. The framework exists to make these expressible, and takes no position on them.

- **Video anybody can actually use** — the feed, the clip recorder and the overlay drawn on it are
  asked for, rendered and reachable only behind `?e2e=1`, so the only thing a board camera does in a
  shipped build is photograph darts. What is missing is not the pipeline but the product: somewhere on
  the match screen to put a board, a way for a person to ask for one, and enough time on real phones
  to trust it. See the warning under [Live board video](#live-board-video) for exactly where each gate
  sits.
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
- **Encoding once does not make decoding free.** A frontend watching two boards and an opponent runs
  three decoders.
