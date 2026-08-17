// The self-test's hands: the only part of onboarding that touches a GPU, a camera or a model.
//
// Everything with an opinion lives in `onboarding.ts` behind `OnboardingHarness`. This is the
// implementation of that interface against a real browser — and it is deliberately the dull half,
// because it is the half no unit test can reach.
//
// It measures through the **camera the person just chose**, after asking for the capture size the
// model wants, because that is the pipeline the scoring screen will actually run. The browser may
// return a landscape or lower-resolution mode; all live consumers use its centre square. The final
// validation is independent: it reads whole square photographs whose answers are known.

import { ensureLiteRtReady, loadModel, unloadModel } from '../vision/model';
import { MODELS } from '../vision/visionRuntime';
import { createMotionDetector } from '../vision/motion';
import { postprocess } from '../vision/postprocess';
import { processPredictions } from '../vision/predictionPipeline';
import { DEFAULT_BOARD_THRESHOLD, DEFAULT_TIP_THRESHOLD } from '../../shared/vision/constants';
import type { OnboardingCamera } from '../hooks/useOnboardingCamera';
import { REFERENCE_BOARDS, type ChosenSettings, type OnboardingHarness, type ReferenceBoard } from './onboarding';

export interface OnboardingHarnessHandle extends OnboardingHarness {
  /** Release the model and the decoded photographs. The camera belongs to the step, not to this. */
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
  camera: OnboardingCamera,
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

  const motion = createMotionDetector({
    preview: camera.video,
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

  /** The square input size the loaded model wants. */
  const inputSize = () => MODELS[loadedModel].inputSize;

  async function timedRun(
    source: HTMLVideoElement | ImageBitmap,
    forceCpuPreprocessing: boolean,
    framing: 'center-square' | 'whole-square',
  ) {
    if (!runner) throw new Error('run before loadRunner');
    // Wall clock around the whole call, which is what makes the cells comparable: LiteRT's own
    // `modelMs` starts after preprocessing, so it barely moves between the preprocessing paths.
    const startedAt = performance.now();
    const result = await runner.run(source, inputSize(), { forceCpuPreprocessing, framing });
    return { totalMs: performance.now() - startedAt, result };
  }

  return {
    now: () => performance.now(),
    apply,

    motionPass: () => motion.analyzeOnce(),

    // Both analyzers get timed, so the gate has to be pointed at each in turn. `setForceCpu` also
    // clears both analyzers' previous frames, which is right: a first pass with nothing to diff
    // against does less work, and the warmup either side of this absorbs it.
    setMotionForceCpu: (force: boolean) => motion.setForceCpu(force),

    cameraMaximumShortSide: () => camera.maximumShortSide(),

    async prepareCamera(model) {
      const entry = MODELS[model];
      if (!entry) throw new Error(`No such model: ${model}`);
      await camera.ensureInputSize(entry.inputSize);
    },

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

    async runCamera(forceCpuPreprocessing) {
      const { totalMs, result } = await timedRun(camera.video, forceCpuPreprocessing, 'center-square');
      return { totalMs, preprocessMode: result.preprocessMode };
    },

    async runBoard(board: ReferenceBoard, forceCpuPreprocessing) {
      const bitmap = boards.get(board.key);
      if (!bitmap) throw new Error(`No reference image for ${board.key}`);
      // Unlike a camera frame, a reference photograph must be consumed whole. The runner enforces
      // that the asset is square rather than silently cropping or distorting a malformed one.
      const { result } = await timedRun(bitmap, forceCpuPreprocessing, 'whole-square');

      // Thresholds are the tuned defaults rather than this device's stored ones, because the counts
      // the reference boards are expected to produce were established at those. No lens correction:
      // these are somebody else's photographs, not this camera's optics.
      const counts = result.outputs.length >= 2
        ? summarise(postprocess(result.outputs[0], result.outputs[1], inputSize())[0])
        : null;
      return { counts };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      motion.reset();
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
