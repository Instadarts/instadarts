# The scoring pipeline

A phone points at the board, and darts appear in the visit. This is how, what is covered by tests,
and — the part worth reading before you change anything — what is **not**, and how to check those
parts by hand.

This repository is where the pipeline is developed. There is no upstream to defer to.

## Where the model came from

`src/client/public/models/s_960.tflite` and `s_1280.tflite` are **ours**: an architecture of our own,
trained here on training data collected and labelled here. Nothing is inherited and nothing is
fine-tuned from somebody else's weights, so no upstream licence reaches this repository — they are
covered by the same GNU AGPL v3 as the code, in [`LICENSE`](../LICENSE).

Worth stating explicitly because it is the question a reader of a repository that ships weights will
have, and because the answer is not the usual one. Detection weights in this space are commonly
Ultralytics-derived, which would drag AGPL obligations in from outside and constrain what the rest of
the stack could be licensed as. That is not the situation here.

The two differ only in input size — 960 and 1280 — and
[`visionRuntime.ts`](../src/client/vision/visionRuntime.ts) picks between them. The training data
itself is not in this repository.

## The path a dart takes

```
camera.ts        a square stream at the configured rate (15fps), autofocus, zoom per lens
   ↓
motion.ts        did the picture change? Only run the model if it did
   ↓             (motionAnalysis.ts is the arithmetic: grey → blur → diff → per-tile counts)
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
| Motion arithmetic | `tests/unit/vision-motion.test.ts` | luma weights, the Gaussian kernel and its edge clamping, the pixel threshold, tile counting |
| Lens geometry | `tests/unit/vision-lens.test.ts` | the homography round trip, ring order, k1 direction, bed placement |
| Board geometry | `tests/unit/vision-geometry.test.ts` | image→board projection and scoring |
| Fusion and tracking | `tests/unit/vision-fusion.test.ts`, `vision-session.test.ts`, `scorer-tips.test.ts` | which tips are one dart, when a visit ends |
| End to end | `tests/e2e/scorer-inference.spec.ts` | a real `.tflite` running on a real board photo, through pairing, into a visit |

The e2e run is the strongest of these: it loads the actual model and asserts the actual darts. It
replaces exactly one thing — `getUserMedia` returns a canvas painted with a board photo
([`fakeCamera.ts`](../tests/e2e/fakeCamera.ts)) — and leaves the model, the preprocessing and the
geometry alone.

## What no test here can reach

CI runs headless Chromium on a machine with no GPU and no camera. Everything below therefore runs in
its fallback path during tests, or does not run at all. **If you change any of it, it must be
checked on hardware — nothing in this repository will tell you that you broke it.**

### The device self-test answers part of this, on the device

A phone that has just been paired opens on **onboarding**
([`OnboardingView.tsx`](../src/client/pages/scorer/OnboardingView.tsx)), in four steps — the last of
them optional.

**Step one is the name.** First because it is the only step answerable before the phone is anywhere
near a board, and because it is the name the *other* screen uses — an owner picks their board camera
by it. Prefilled from whatever this device already had, including after *Set up again*, which keeps
the name precisely so nobody has to type it twice.

**Step two is the camera** ([`useOnboardingCamera.ts`](../src/client/hooks/useOnboardingCamera.ts)):
access is requested if it has not already been granted — and not before this step, so nobody answers
a permission dialog while they are still typing — a camera is chosen where there is more than one,
and the zoom is offered. Nothing here asks anybody to aim at a board; that is done on the mount,
later. A phone with no camera, or whose owner refuses one, cannot finish setup; it is told which of
those happened and can still leave.

Deliberately **not** the vision runtime: `visionRuntime.start()` arms the motion gate, whose trigger
runs inferences through the same model singleton step two loads and unloads. So this drives
[`camera.ts`](../src/client/vision/camera.ts) directly against a preview of its own, while
`ScorerPage` keeps the runtime's camera shut.

**Step three is the self-test**, and it runs *through that camera* — which is the point: it does on
real hardware what CI cannot. It times both motion analyzers, times each model on all four pairings
of preprocessing and inference, and then reads two photographs whose answers are known — 8 board
points and no tips on the empty one, 8 and 3 on the other. It sets the model and the three CPU
overrides from what it finds, and where the results are wrong it walks down the fallbacks until they
are right, which is what catches the failure mode where a vendor's WebGPU returns *empty results and
no error at all*.

**Timings come from the camera; correctness comes from the photographs.** The two are separate
harness calls (`runCamera`, `runBoard`) rather than one, because they answer different questions: a
frame's real cost can only be measured on the real source, and an answer can only be checked against
a picture whose answer is known. Nobody knows what the camera is pointed at.

**Step four is optional, and is the only part of setup that draws anything.** Offered from the
results rather than imposed: point the phone at a real board and it runs the chosen configuration
about twice a second, drawing a cyan spider where it thinks the board is and orange dots on the tips
it finds, with a bar counting board points out of eight. It exists because everything before it
proved the device can read *photographs* — which is what makes it a validation, and also what stops
it being the whole story. Nobody has yet aimed this phone at the board it will watch, and the step
that shows the model working is the same step that can say where to stand it.

Everything drawn is filtered at the pipeline's own thresholds, so what appears is what would be
scored and the bar can never read red under a spider that is showing. It computes no scores and
displays none — the question is whether it can see the board, not what anybody hit.

Reach it again from **Settings → Set up again**, which also clears the camera choice and its zoom —
step one asks for them again. The decision logic is in
[`lib/onboarding.ts`](../src/client/lib/onboarding.ts) and is unit-tested against fakes; everything
that needs a GPU or a camera is behind `OnboardingHarness` in
[`lib/onboardingHarness.ts`](../src/client/lib/onboardingHarness.ts).

#### What each number is, and how it relates to the frame line

Each row of the results shows only what the path it settled on cost; **tapping the row** opens the
working behind it — the two analyzers for motion, the four pairings for a model. The self-test and
the frame line under the camera preview measure different spans, so they are not expected to agree —
this is what each one covers.

| Row | Covers | Notes |
| --- | --- | --- |
| Motion detector | one analyzer pass, on each analyzer | Always at `analyzeSize` **240 px** whatever the camera runs at, so this does not move with camera resolution. A single-digit CPU result is normal: it is 57,600 pixels, and the GPU cannot amortise `createImageBitmap` plus a `mapAsync` readback over that little work. |
| 960 / 1280 px model | a **whole `run()`**, on all four pairings | Preprocessing, inference and readback together. Not split into a preprocessing figure and an inference figure: the GPU preprocessor never synchronises, so its compute lands inside the readback LiteRT's `modelMs` covers while the CPU's happens in full beforehand — subtracting would credit the GPU with work it merely hid. The whole run contains the same things on every path. **The camera is re-opened at each model's input size** before it is timed, since capture is square at that size and the scoring screen does the same — timing the large model against a small stream would measure a configuration that never runs. |
| **The frame line** (`CameraPanel`) | all of `infer()` | Everything in a model cell, plus `ensureModel`, the calibration frame capture, `postprocess` and the geometry. |

So the frame line should read **a little above the winning cell** of whichever model is in use — the
two now read the same source at the same size, so a large gap is the rest of `infer()` and not a
difference in what was measured.

#### The four pairings, and why it is a table

Preprocessing and inference each have a CPU and a GPU path, and they **interact** — the fastest
pairing is not always the pairing of the two individually fastest, and holding one constant while
varying the other can only ever answer "which is better, given the other". So each model is timed on
all four, and both switches are set from the single cell that won. That is also what stops the two
settings ending up in a combination nothing ever measured.

`gpu-cpu` — preprocess in the shader, infer on the CPU — is the interesting one. It has to move the
input tensor from the GPU into WASM memory to run it: **11.1 MB at 960 px, 19.7 MB at 1280**. Whether
that beats a CPU preprocess is genuinely a question about the device, which is why it is measured
rather than assumed. It is opt-in per call, so callers that pass no options get exactly the old
behaviour.

#### The WebGPU device is ours, when LiteRT has none

Nothing here creates its own device: the preprocessing shader and the motion detector's analyzer both
ask LiteRT for one. So when LiteRT's `createDefaultWebGpuDevice` comes back empty, three features
lose their GPU path at once and each reports it as its own failure — which is exactly how a machine
with a working graphics card ends up reporting `cpu` everywhere.

`ensureLiteRtReady` now requests an adapter and hands LiteRT a device through `setWebGpuDevice` **when
it has none of its own**, before the first model is compiled (`setWebGpuDevice` replaces the default
environment, and a model compiled into the old one does not belong to the new one). It never replaces
a working device: LiteRT asks its adapter for whatever its own inference needs, and a plainer device
of ours could be worse.

### WebGPU

- **The preprocessing compute shader** (`WEBGPU_PREPROCESS_SHADER` in `model.ts`) — samples the
  video texture straight into the tensor buffer. In CI, WebGPU is unavailable and the CPU canvas
  path runs instead, so the shader is never compiled. A wrong swizzle or a wrong normalization here
  produces *plausible but wrong* keypoints, not an error.
- **The two motion shaders** (`motion.ts`: horizontal blur, then vertical-blur-diff-and-aggregate)
  — the WGSL reimplementation of what `motionAnalysis.ts` does in TypeScript. The unit tests pin the
  TypeScript; nothing pins that the shaders still agree with it. The split is two dispatches rather
  than three because the horizontal pass re-samples the source independently per thread, which
  removes the cross-thread dependency a shared intermediate would have needed.
- **The fallback chain itself** — WebGPU → WASM on device loss, and the mid-run fall back from the
  GPU analyzer to the CPU one when a pass throws.

*To check:* **run the self-test** (Settings → Set up again) on a phone whose browser has WebGPU. It
reports which path each stage actually took and what each one cost, and it will not finish green
unless the chosen configuration reads both reference boards correctly — so a shader that produces
plausible-but-wrong keypoints fails it rather than passing quietly. Then throw, because the self-test
reads its answers off photographs and so cannot tell you the live pipeline is right.

**The three CPU toggles in the scorer's settings** — *Motion detector*, *Preprocessing* and
*Inference* — each force one WebGPU path onto its CPU equivalent, independently and per device. They
persist in that device's settings, so a phone left with one on stays that way.

The self-test sets them, which is most of what they are for: it notices a path that fell back on its
own and makes the setting agree, and it turns one on when that is what makes the reference boards
read correctly. Setting them by hand is still the tool for the question it cannot ask — whether a
vendor's WebGPU is subtly wrong *on a real board* rather than on a photograph. Turn one off, throw,
and see whether scoring gets better.

### The WASM runtime

- **Thread count** (`WASM_MAX_THREADS = 4`) — a cap chosen because a small model gains little past a
  few threads while heat and contention grow. CI has no phone to get warm.
- **Cross-origin isolation** — without it LiteRT silently drops to single-threaded WASM. The e2e
  suite asserts `crossOriginIsolated` is true, which catches the headers being wrong, but not the
  performance consequence.

*To check:* the self-test's inference figure is the quick reading, and is what the model choice is
made from — under 250 ms on the small model is what makes the large one worth trying at all. It
cannot see heat, though: run a full leg on the phone you intend to use, watch the ms figure, and
confirm it behaves over the length of a session rather than only at the start. `WASM_MAX_THREADS` is
the knob if it does not.

### The camera

- **Constraints** — `resizeMode: crop-and-scale`, `focusMode: continuous`, `contentHint: detail`.
  None is standard; each is honoured by some browsers and ignored by others, and the fake camera in
  tests honours none of them — only the requested square size, which onboarding depends on.
- **Zoom** — `getCapabilities().zoom` exists on Android Chrome and mostly does not on iOS Safari.
  The per-lens zoom memory can only be exercised with a lens.
- **Autofocus behaviour** — a mounted camera looking at a board with darts standing out of it is
  the case the `detail` content hint is there for.
- **Where the camera stands is a model requirement, not a preference.** It wants the board **from an
  angle on both axes** — off to one side rather than square on, and above or below the bull rather
  than level with it. Straight in front is the view it reads worst, and nothing in the pipeline says
  so: the keypoints simply come back weaker, so the symptom is a board that will not hold 8 of 8
  rather than an error. Setup's last step is where somebody finds this out — see the bar there.

*To check:* on the phone, zoom until the board fills the frame, then calibrate: the projected
spider is slid onto the board's real wires, so how well it can be made to sit on them is the test.
Then throw, and confirm scoring behaves as expected.

### Motion gating, in the real world

The unit tests pin the arithmetic on synthetic pixels. Whether the tuning behaves as expected in a
real room, against real movement and real light, is not something they can answer — the gate weighs
how much of the picture changed and how long it stayed changed, and only a board in a room exercises
that.

Two parts of it are about noise rather than about motion, and neither can be judged from synthetic
pixels:

- **A 5×5 separable Gaussian blur `[1,4,6,4,1]`, applied before the frame difference.** Every pixel
  is compared carrying its neighbourhood with it, so a dart edge too faint to cross the threshold on
  its own still contributes instead of being dropped — and a pixel dropped here is gone, since
  nothing downstream can recover it. Border pixels clamp to the edge; the kernel is never truncated.
- **A per-pixel threshold that varies with brightness** (`pixelThresholdMult`). The multiplier is a
  parabolic ramp: 1.0× at mid-grey, `pixelThresholdMult`× at black and white. It reads the
  **previous** frame's pixel — the board behind the dart — so a dark wire or a white segment gets a
  lowered threshold, and a mid-grey dart tip landing on one is easier to see. What that costs in a
  noisy room is exactly what only a room can tell you.

*To check:* play with it. Arm the board, use it as it would be used, and confirm it behaves as
expected — both that throws are picked up and that it stays quiet when it should. If it does not,
`MOTION_DEFAULTS` in `motion.ts` is where that is decided.

### Power management

A scoring device switches its own camera off, and eventually itself, when nothing needs it — see
[`lib/scorerPower.ts`](../src/client/lib/scorerPower.ts). The rules are pinned by unit tests and the
e2e suite drives the delays down to seconds, but three of the browser behaviours the design rests on
are unreachable from a headless run:

- **Re-opening a camera without a prompt.** After `track.stop()`, a later `getUserMedia` should
  resolve straight away because the origin's permission is already granted. The fake camera in tests
  grants everything, so it can never show this failing.
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
- **A real Wi-Fi blip, as against a heartbeat cut in a test.** A device that drops and comes back
  must not read its own reconnect as a match starting — that is what
  [`scoringContextId`](../src/shared/protocol.ts) and
  [`lib/scorerReconnect.ts`](../src/client/lib/scorerReconnect.ts) are for, and the e2e suite covers
  the mechanism. What it cannot produce is the real thing: a phone that loses its access point for
  two minutes, with the camera off because its owner switched it off.

The screen going black is *not* one of these stages. The screensaver is a display state and nothing
else — inference, motion gating and tips carry on underneath it, and **only a touch or a key on the
phone itself brings the screen back**. A match starting or ending does not.

*To check:* mount the phone, pair it, and leave it alone through an evening. Confirm the camera
stops when it should and comes back when a match starts, that the device sleeps and that a tap
wakes it, that switching the camera off from the frontend and then walking out of Wi-Fi range leaves
it off when the phone reconnects, and — the only measurement that answers the question this was built
for — that the battery is in a reasonable state the next morning.

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
