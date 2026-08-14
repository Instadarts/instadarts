// The self-test's hands: the only part of onboarding that touches a GPU, a canvas or a model.
//
// Everything with an opinion lives in `onboarding.ts` behind `OnboardingHarness`. This is the
// implementation of that interface against a real browser — and it is deliberately the dull half,
// because it is the half no unit test can reach.

import { ensureLiteRtReady, loadModel, unloadModel } from '../vision/model';
import { MODELS } from '../vision/visionRuntime';
import { createMotionDetector } from '../vision/motion';
import { postprocess } from '../vision/postprocess';
import { processPredictions } from '../vision/predictionPipeline';
import { DEFAULT_BOARD_THRESHOLD, DEFAULT_TIP_THRESHOLD } from '../../shared/vision/constants';
import { REFERENCE_BOARDS, type ChosenSettings, type OnboardingHarness, type ReferenceBoard, type RunSample } from './onboarding';

/**
 * The square the motion source is painted at.
 *
 * The gate resizes whatever it is given down to its own 240 px working size, so this only has to be
 * big enough to be a realistic thing to resize *from* — the camera runs at the model's input size,
 * and 960 is the smaller of the two.
 */
const MOTION_SOURCE_SIZE = 960;

/** Frames a second the fake stream offers, matching what the scorer asks a real camera for. */
const SOURCE_FRAME_RATE = 15;

/** How often the canvas is repainted. A `captureStream` only emits a frame when something is drawn. */
const REPAINT_MS = 100;

export interface OnboardingHarnessHandle extends OnboardingHarness {
  /** Release the model, the stream and the decoded photographs. Safe to call twice. */
  dispose(): Promise<void>;
}

/**
 * Build a harness, or throw if this browser cannot even get to the starting line.
 *
 * `apply` is called the moment a decision is made rather than at the end, which is what lets
 * somebody cancel half way through and keep what has already been proved about their device.
 */
export async function createOnboardingHarness(
  apply: (patch: Partial<ChosenSettings>) => void,
): Promise<OnboardingHarnessHandle> {
  const boards = await decodeBoards();

  // **Before the motion detector exists**, because its GPU analyzer does not make its own WebGPU
  // device — it asks LiteRT for one, and LiteRT only has one once its environment has been set up
  // (which is also where we hand it ours, if it could not make its own). A gate built before that
  // finds nothing, throws, and latches itself onto the CPU permanently, reporting `cpu` on hardware
  // whose GPU detector works perfectly in the real pipeline.
  //
  // Enforced here rather than by measuring the model stages first: the requirement belongs to the
  // thing that has it, and a stage order is too easy to change without noticing what depended on it.
  await ensureLiteRtReady();

  // A canvas painted with a real board, published as a stream, read back through a `<video>`. The
  // motion gate takes a video element and nothing else, and this is the same shape the e2e suite
  // feeds it — so what gets timed is the work a live camera would cause, not an approximation of it.
  const canvas = document.createElement('canvas');
  canvas.width = MOTION_SOURCE_SIZE;
  canvas.height = MOTION_SOURCE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser would not give us a 2D canvas to test with.');

  const source = boards.get('darts')!;
  const paint = () => ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  paint();

  const stream = canvas.captureStream(SOURCE_FRAME_RATE);
  const repaint = window.setInterval(paint, REPAINT_MS);

  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  await firstFrame(video);

  const motion = createMotionDetector({
    preview: video,
    // Never armed, never triggered: the loop is what paces passes to ten a second, and this only
    // ever calls `analyzeOnce`. Saying no to all three makes that structural rather than a habit.
    canArm: () => false,
    canTrigger: () => false,
    isTriggerBusy: () => false,
    onTrigger: () => {},
  });

  let runner: Awaited<ReturnType<typeof loadModel>> | null = null;
  /** Which model `runner` is, since a `ModelRunner` does not say. Set only by `loadRunner`. */
  let loadedModel = '';
  let disposed = false;

  return {
    now: () => performance.now(),
    apply,

    motionPass: () => motion.analyzeOnce(),

    // Both analyzers get timed, so the gate has to be pointed at each in turn. `setForceCpu` also
    // clears both analyzers' previous frames, which is right: a first pass with nothing to diff
    // against does less work, and the warmup either side of this absorbs it.
    setMotionForceCpu: (force: boolean) => motion.setForceCpu(force),

    async loadRunner(model, forceCpuInference) {
      const entry = MODELS[model];
      if (!entry) throw new Error(`No such model: ${model}`);
      // Unconditionally, every time. `loadModel` caches by url and ignores the accelerator asked for
      // on a cache hit, so without this a "CPU" measurement can quietly be the WebGPU runner again.
      // It also clears the latch that disables GPU preprocessing after one failure, so a single
      // hiccup cannot poison every measurement that follows it.
      await unloadModel();
      runner = await loadModel(entry.url, forceCpuInference ? 'wasm' : 'webgpu');
      loadedModel = model;
      return { accelerator: runner.accelerator || 'wasm' };
    },

    async run(board: ReferenceBoard, forceCpuPreprocessing): Promise<RunSample> {
      if (!runner) throw new Error('run() before loadRunner()');
      const bitmap = boards.get(board.key);
      if (!bitmap) throw new Error(`No reference image for ${board.key}`);
      // The input size has to match the model that is loaded, not the one the settings name: the
      // two differ for the whole of stage three, which is the point of that stage.
      const inputSize = MODELS[loadedModel].inputSize;

      // Wall clock around the whole call, which is what makes the cells comparable: LiteRT's own
      // `modelMs` starts after preprocessing, so it barely moves between the preprocessing paths.
      const startedAt = performance.now();
      const result = await runner.run(bitmap, inputSize, { forceCpuPreprocessing });
      const totalMs = performance.now() - startedAt;

      // Thresholds are the tuned defaults rather than this device's stored ones, because the counts
      // the reference boards are expected to produce were established at those. No lens correction:
      // these are somebody else's photographs, not this camera's optics.
      const counts = result.outputs.length >= 2
        ? summarise(postprocess(result.outputs[0], result.outputs[1], inputSize)[0])
        : null;

      return { totalMs, preprocessMode: result.preprocessMode, counts };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      window.clearInterval(repaint);
      motion.reset();
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      for (const bitmap of boards.values()) bitmap.close();
      await unloadModel();
      runner = null;
    },
  };
}

/** Counts, or null where the board could not be solved at all — the silent-failure signature. */
function summarise(keypoints: ReturnType<typeof postprocess>[number]) {
  const result = processPredictions(keypoints, DEFAULT_BOARD_THRESHOLD, DEFAULT_TIP_THRESHOLD, 0);
  if (!result) return null;
  return { boardKeypoints: result.boardKeypoints, tipKeypoints: result.tipKeypoints };
}

/** Fetch and decode both photographs up front, so no measurement includes a download. */
async function decodeBoards(): Promise<Map<string, ImageBitmap>> {
  const entries = await Promise.all(
    REFERENCE_BOARDS.map(async (board) => {
      const response = await fetch(board.url);
      if (!response.ok) throw new Error(`Could not load ${board.url} (${response.status})`);
      return [board.key, await createImageBitmap(await response.blob())] as const;
    }),
  );
  return new Map(entries);
}

/**
 * Wait until the element actually has a picture in it.
 *
 * `play()` resolving is not the same thing: it says the element started, not that a frame arrived,
 * and the motion gate refuses a preview with no dimensions. The timeout turns a stream that never
 * produces anything into a message rather than a screen that sits there.
 */
function firstFrame(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('The test picture never arrived — this browser may not support canvas capture.'));
    }, 5000);
    const done = () => {
      if (video.videoWidth === 0) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('timeupdate', done);
    };
    video.addEventListener('loadedmetadata', done);
    video.addEventListener('timeupdate', done);
  });
}
