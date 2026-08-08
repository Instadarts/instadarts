# The scoring pipeline

A phone points at the board, and darts appear in the visit. This is how, what is covered by tests,
and — the part worth reading before you change anything — what is **not**, and how to check those
parts by hand.

This repository is where the pipeline is developed. There is no upstream to defer to.

## The path a dart takes

```
camera.ts        a square 15fps stream, autofocus, zoom remembered per lens
   ↓
motion.ts        did the picture change? Only run the model if it did
   ↓             (motionAnalysis.ts is the arithmetic: grey → diff → clean → per-tile counts)
model.ts         one frame → two tensors. WebGPU preprocessing + inference, WASM CPU fallback
   ↓
postprocess.ts   tensors → keypoints: 8 board classes and up to 32 dart tips
   ↓
predictionPipeline.ts   threshold, dedup, undistort, homography, project, clamp
   ↓
                 board coordinates, published to the server — and the camera's job ends
```

Two things it deliberately does **not** do. It does not score: a coordinate is worth a number only
once the server has fused what every camera saw, or two cameras seeing one dart would produce two.
And it holds no dart state: which tips are new is
[`server/scoring/`](../src/server/scoring/)'s question, which is exactly what lets a second camera
join mid-visit with nothing to reconcile.

`lensGeometry.ts` is off to one side: it projects the board's spider back into the camera's picture
so a person can slide the lens correction until the drawn lines sit on the real wires.

## What the tests cover

| | where | what it pins |
|---|---|---|
| Tensor decoding | `tests/unit/vision-postprocess.test.ts` | the `[C, N]` stride, the confidence floor, the 32 cap, pixel-vs-normalized coordinates |
| Motion arithmetic | `tests/unit/vision-motion.test.ts` | luma weights, the pixel threshold, speckle rejection, tile counting |
| Lens geometry | `tests/unit/vision-lens.test.ts` | the homography round trip, ring order, k1 direction, bed placement |
| Board geometry | `tests/unit/vision-geometry.test.ts` | image→board projection and scoring |
| Fusion and tracking | `tests/unit/vision-fusion.test.ts`, `vision-session.test.ts`, `scorer-tips.test.ts` | which tips are one dart, when a visit ends |
| End to end | `tests/e2e/scorer-inference.spec.ts` | a real `.tflite` running on a real board photo, through pairing, into a visit |

The e2e run is the strongest of these: it loads the actual model and asserts the actual darts. It
replaces exactly one thing — `getUserMedia` returns a canvas painted with a board photo
([`virtualCamera.ts`](../tests/e2e/virtualCamera.ts)) — and leaves the model, the preprocessing and
the geometry alone.

## What no test here can reach

CI runs headless Chromium on a machine with no GPU and no camera. Everything below therefore runs in
its fallback path during tests, or does not run at all. **If you change any of it, it must be
checked on hardware — nothing in this repository will tell you that you broke it.**

### WebGPU

- **The preprocessing compute shader** (`WEBGPU_PREPROCESS_SHADER` in `model.ts`) — samples the
  video texture straight into the tensor buffer. In CI, WebGPU is unavailable and the CPU canvas
  path runs instead, so the shader is never compiled. A wrong swizzle or a wrong normalization here
  produces *plausible but wrong* keypoints, not an error.
- **The three motion shaders** (`motion.ts`: preprocess, dilate, erode-and-aggregate) — the WGSL
  reimplementation of what `motionAnalysis.ts` does in TypeScript. The unit tests pin the
  TypeScript; nothing pins that the shaders still agree with it.
- **The fallback chain itself** — WebGPU → WASM on device loss, and the mid-run fall back from the
  GPU analyzer to the CPU one when a pass throws.

*To check:* open the scorer on a phone whose browser has WebGPU, start the camera, and confirm the
frame line under the preview reads `webgpu` rather than `cpu` — then throw, and confirm scoring
behaves as expected. Note the reported ms while you are there: it is the number to compare against
after any change to this path.

### The WASM runtime

- **Thread count** (`WASM_MAX_THREADS = 4`) — a cap chosen because a small model gains little past a
  few threads while heat and contention grow. CI has no phone to get warm.
- **Cross-origin isolation** — without it LiteRT silently drops to single-threaded WASM. The e2e
  suite asserts `crossOriginIsolated` is true, which catches the headers being wrong, but not the
  performance consequence.

*To check:* run a full leg on the phone you intend to use, watch the ms figure, and confirm it
behaves as expected over the length of a session rather than only at the start. `WASM_MAX_THREADS`
is the knob if it does not.

### The camera

- **Constraints** — `resizeMode: crop-and-scale`, `focusMode: continuous`, `contentHint: detail`.
  None is standard; each is honoured by some browsers and ignored by others, and the virtual camera
  in tests honours none of them.
- **Zoom** — `getCapabilities().zoom` exists on Android Chrome and mostly does not on iOS Safari.
  The per-lens zoom memory can only be exercised with a lens.
- **Autofocus behaviour** — a mounted camera looking at a board with darts standing out of it is
  the case the `detail` content hint is there for.

*To check:* on the phone, zoom until the board fills the frame, then calibrate: the projected
spider is slid onto the board's real wires, so how well it can be made to sit on them is the test.
Then throw, and confirm scoring behaves as expected.

### Motion gating, in the real world

The unit tests pin the arithmetic on synthetic pixels. Whether the tuning behaves as expected in a
real room, against real movement and real light, is not something they can answer — the gate weighs
how much of the picture changed and how long it stayed changed, and only a board in a room exercises
that.

*To check:* play with it. Arm the board, use it as it would be used, and confirm it behaves as
expected — both that throws are picked up and that it stays quiet when it should. If it does not,
`MOTION_DEFAULTS` in `motion.ts` is where that is decided.

### Power management

A scoring device switches its own camera off, and eventually itself, when nothing needs it — see
[`lib/scorerPower.ts`](../src/client/lib/scorerPower.ts). The rules are pinned by unit tests and the
e2e suite drives the delays down to seconds, but three of the browser behaviours the design rests on
are unreachable from a headless run:

- **Re-opening a camera without a prompt.** After `track.stop()`, a later `getUserMedia` should
  resolve straight away because the origin's permission is already granted. The virtual camera in
  tests grants everything, so it can never show this failing.
- **iOS Safari's permission lifetime.** Safari's grant is per page-session rather than per origin,
  so a device that reloaded may be prompted again — and a prompt raised from a timer rather than a
  tap is one nobody is there to answer.
- **A camera asked for from the other room.** The owner's switch, and the automatic start when a
  match begins, both need the phone's page to be visible. A backgrounded tab may refuse or mute the
  track. It is expected to fail there; what matters is that it *says* so, through `scorer_camera`'s
  error, and that the owner's row shows it.
- **The wake lock actually being released, and the phone actually sleeping.** Releasing it does not
  turn the screen off — it lets the OS do so on its own schedule, which no test environment has.
- **Whether the socket survives sleep on Android.** It may not, which is fine: the device closes it
  deliberately on the way into standby, and the server's heartbeat
  ([`heartbeat.ts`](../src/server/heartbeat.ts)) reclaims anything that dies without closing.

*To check:* mount the phone, pair it, and leave it alone through an evening. Confirm the camera
stops when it should and comes back when a match starts, that the device sleeps and that a tap
wakes it, and — the only measurement that answers the question this was built for — that the battery
is in a reasonable state the next morning.

### Full screen

There is no fullscreen button on iPhone, because Safari there has no element fullscreen at all —
only a `<video>` can go fullscreen. [`FullscreenButton`](../src/client/components/FullscreenButton.tsx)
renders nothing when `requestFullscreen` is missing rather than offering something that throws. The
only route to a chrome-less app on that platform is Add to Home Screen with a web manifest, which
this repository does not have.

*To check:* on an iPhone, confirm no button appears and nothing looks broken by its absence. On
Android, confirm the back gesture leaving full screen puts the button back into its "enter" state
rather than desyncing it.

## Changing the tuning

The constants in [`shared/vision/constants.ts`](../src/shared/vision/constants.ts) and
`MOTION_DEFAULTS` in `motion.ts` are measurements, not preferences. If a test wants a different
value, the test is wrong. Change one only with a board in front of you, and change one at a time.
