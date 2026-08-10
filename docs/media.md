# Media — peer connections between the devices in a match

The optional feature that lets the people in a match see something: a board, and eventually each
other. It is off in one place and on in one place, and where a peer connection cannot be made it is
simply unavailable rather than degraded.

**What exists today is the transport, stills on top of it, and live board video behind the `?e2e=1`
seam.** Links come up between every pair that needs one, each with two datachannels; a camera will
photograph a square of its board on request — which is what puts a picture of each dart under the
dart slots — and it will also publish a live feed of a square it is *told* to look at, from one
encoder to however many viewers. The feed is asked for and rendered only in a build with the seam
open, because it has not yet been proven on real phones. See
[What is not built](#what-is-not-built).

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

Measured in the e2e container at the sizes in `STILL`: **under 1ms to draw, 1ms to encode, 7–17ms
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
| `still_request` | `{ id, region?, tag? }` |
| `still` | `{ id, tag?, width, height, mime }` **and the JPEG bytes, in the same message** |
| `still_refused` | `{ id, reason }` — `no_frame`, `not_located` or `busy` |

A still is one self-describing binary message: `[uint32 headerLength][JSON][bytes]`. A header sent
separately and paired with "whatever binary arrives next" stops working the moment two are in
flight, and three darts landing in one throw window makes that ordinary.

`id` is the requester's, echoed back, so an answer is matched to its own request. `tag` is an opaque
value the device echoes without interpreting — dart evidence puts `{ dart: <index> }` in it, and that
is what lets an **observer**, who never sent a request and has no id to match, place the picture under
the right slot.

### Who may ask, and who receives

**Only the owner asks.** A camera honours a request from the peer its roster marks
[`own`](#the-two-gates-on-a-board-camera) and from nobody else; anyone else gets silence rather than a
refusal, since a peer with no business asking learns nothing from an answer.

**Everybody receives.** One capture, one encode, written to every open link — owner, opponent,
spectators. That is what the device↔opponent link is for, it keeps the camera the single account of
what its board looks like, and it means an observer's copy cannot drift from the owner's.

Together those two make observers exactly what they should be: they see what the owner's camera was
asked for, and have no say in what that is.

## Live board video

⚠️ **Behind `?e2e=1`.** A frontend asks for a feed and renders one only where the seam is open. The
device half is not gated — it answers whoever is entitled to command it — but in a shipped build
nobody asks.

Three commands, and the split between the first two and the third is the point:

| Message | |
| --- | --- |
| `video_start` / `video_stop` | Publish, or stop. **No region** — starting a feed and framing it are different decisions. |
| `video_region` | `{ region, transitionMs? }` — the **director**: the same square vocabulary a still uses, plus how long to take getting there. |
| `video_state` | `{ on, reason? }` — broadcast to every viewer, not only to whoever asked. |

Owner-only, enforced exactly where a still request is: [`useVideoResponder`](../src/client/hooks/useVideoResponder.ts)
drops anything from a peer the roster does not mark `own`, in silence.

`video_state` exists because a spectator never sent a command and would otherwise have no way to tell
a feed that is off from a link that is broken — both are a black rectangle. Its `reason` is one of
`not_offered` (the phone's tier is not `video`), `no_camera`, or `no_encoder` (a browser without
`VideoEncoder`; Safari before 16.4).

**The owner's wish outlives the camera.** A feed asked for in the lobby starts when the camera does,
and survives the camera being switched off and on — the owner never withdrew the request and cannot
see that anything happened.

### `keyframe` is the one command anyone may send

Every other command is the owner's. This one is not, deliberately: a viewer asking for a keyframe is
saying *"I cannot decode what you are sending"*, which is a statement about them and changes nothing
about what is shown. Refusing it would leave an opponent staring at a broken picture with no way to
say so.

What stops it being an amplifier is a rate limit rather than a permission check — several viewers
losing the same frame all ask at once, and a keyframe costs *every* viewer bandwidth, so one answer
serves all of them (`VIDEO.keyframeMinIntervalMs`).

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
- **Drop, never queue.** A link with more than `VIDEO.maxBufferedBytes` already queued is skipped for
  that frame — judged per viewer, so one slow peer does not cost the others.

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
| ← | `media_config` | what the deployment allows, sent on connect beside `mode_catalog` |
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
| the deployment | `MEDIA=0 npm start` ([`env.ts`](../src/server/env.ts)) | on |
| a browser | the switch in the top bar's device panel | on |
| a phone | *Share this view*, in the scoring device's settings — `disabled`, `stills` or `video` | `video` |

A client that has opted out never announces itself, so it appears in nobody's roster.

Distinct from all three, and not an opt-out: **which** board a frontend shows. Turning media off
stops this browser taking part at all, including watching the opponent; nominating no board camera
leaves everything else working and only stops anybody seeing *your* board.

## ICE, and why video may simply not work

```sh
MEDIA_ICE_URLS=stun:stun.example.org:19302 npm start   # default: none
```

**Empty by default**, which means host candidates only: a scoring device reaches its own frontend
across the room, and an opponent in another house reaches nobody. Nothing about a match leaves the
deployment unless somebody asks for it.

There is no TURN and there is no fallback. Where a peer connection cannot be made the feature is
unavailable to that user, and the interface must treat that as ordinary rather than as an error —
even with STUN configured, symmetric NAT will defeat some pairs.

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
src/shared/media.ts          peers, rosters, the profile, the channel names, MAX_SDP_BYTES
src/server/media.ts          the peer map, the plan, the roster, the relay
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

> **A trap worth knowing about.** Chrome hides local IPs behind `.local` mDNS names in ICE
> candidates, and mDNS does not resolve in a headless container, so two browser contexts cannot find
> each other and the failure looks exactly like a bug in this code.
> `playwright.config.ts` passes `--disable-features=WebRtcHideLocalIpsWithMdns` for that reason.

## What is not built

All ⏳. The framework exists to make these expressible, and takes no position on them.

- **Video anybody can actually use** — the feed is asked for and rendered only behind `?e2e=1`. What
  is missing is not the pipeline but the product: somewhere on the match screen to put a board, a way
  for a person to ask for one, and enough time on real phones to trust it.
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
