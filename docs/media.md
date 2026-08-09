# Media — peer connections between the devices in a match

The optional feature that lets the people in a match see something: a board, and eventually each
other. It is off in one place and on in one place, and where a peer connection cannot be made it is
simply unavailable rather than degraded.

**What exists today is the transport.** Links come up between every pair that needs one, each with
two datachannels, and nothing yet sends a picture through them. The encoder, the decoder, the policy
for which link to open when, and every piece of user interface are ⏳ — see
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
src/client/media/mesh.ts     the set of links, and where part 3's single encoder will live
src/client/hooks/useMediaMesh.ts   mounted by App and ScorerApp alike
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

- **The encoder and the wire format** — `VideoEncoder` configuration, frame sequencing, keyframe
  cadence and requests, the `bufferedAmount` drop policy, and decoding on the viewer.
- **Which link to open when** — the mesh currently connects to every peer it is offered. Note this is
  a smaller question than it was: *which board is watchable at all* is settled by the two gates
  above, on the server, and is not the client's to decide.
- **Stills** — the control channel and its message kinds exist; nothing produces one.
- **Any user interface** — no video on the match screen, no board tiles, nothing outside the
  diagnostics panel.
- **Outgoing video from a frontend** — the mesh is symmetric already; no frontend publishes.

## Known limitations

- **A socket reconnect rebuilds every link** (a few seconds of nothing). New socket, new peer id —
  the price of the server holding nothing across one. Most visible after a *server* restart, where
  the peer connections were perfectly healthy and are torn down anyway.
- **No board video while the camera is off.** Media reads the vision runtime's camera and never
  starts one, so the two-minute camera-off stage ends the board view and standby ends everything.
  Between legs there is nothing to watch. See [the two power stages](./glossary.md#scoring-and-the-two-power-stages).
- **Encoding once does not make decoding free.** A frontend watching two boards and an opponent runs
  three decoders.
