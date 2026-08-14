// The self-test: what this phone can do, and what to set because of it.
//
// A phone either runs the scoring pipeline well or it does not, and until now the only way to find
// out was to throw darts and watch. Worse, a device can fail *silently* — LiteRT reports no error
// and returns empty results, which looks exactly like a camera pointed at the wrong wall. This
// measures the stages **both ways**, notices which path each one actually took, picks a model, and
// then proves the whole thing on two photographs whose answers are already known.
//
// Both ways matters. A stage that only reports the path it chose leaves somebody staring at "cpu"
// with no way to tell a failed GPU from a GPU that lost a fair race — and those want completely
// different things done about them.
//
// **Nothing here touches React or the DOM.** Everything the outside world can do arrives through
// `OnboardingHarness`, which is what lets the decisions below — the model gates, the path selection,
// the validation ladder — be tested without a GPU, a camera or a browser. The real harness is built
// in `onboardingHarness.ts`; the tests pass a fake.

/** How a measurement reads. The user colours by this; the numbers are provisional, see BRACKETS. */
export type Verdict = 'good' | 'okay' | 'bad';

/** What one path cost, or `dnf` — it was tried and did not work. */
export type PathResult = { kind: 'ms'; ms: number } | { kind: 'dnf' };

export const took = (ms: number): PathResult => ({ kind: 'ms', ms });
export const DNF: PathResult = { kind: 'dnf' };

export interface StagePaths {
  cpu: PathResult;
  gpu: PathResult;
  selected: 'cpu' | 'gpu';
}

/**
 * One model, timed on every combination of preprocessing and inference.
 *
 * Keyed `preprocessing-inference`. All four are real: `gpu-cpu` preprocesses in the shader and then
 * moves the input tensor into WASM memory to run there — 11.1 MB of readback at 960 px and 19.7 at
 * 1280, against a CPU preprocess that may well cost more. Which wins is a question about the device,
 * which is the whole reason it is measured rather than assumed.
 *
 * Every cell is a whole `run()`: preprocessing, inference and readback. That is the only figure that
 * contains the same things on every path, and it is also what a frame actually costs.
 */
export type ComboKey = 'cpu-cpu' | 'cpu-gpu' | 'gpu-cpu' | 'gpu-gpu';
export type ModelMatrix = Record<ComboKey, PathResult>;

const COMBO_KEYS: ComboKey[] = ['cpu-cpu', 'cpu-gpu', 'gpu-cpu', 'gpu-gpu'];

function comboOf(key: ComboKey): { preprocessing: 'cpu' | 'gpu'; inference: 'cpu' | 'gpu' } {
  const [preprocessing, inference] = key.split('-') as ['cpu' | 'gpu', 'cpu' | 'gpu'];
  return { preprocessing, inference };
}

/**
 * The fastest combination, with ties inside the noise margin broken towards the GPU.
 *
 * Deterministic rather than "keep what is already set": two runs of the self-test on one phone
 * should agree, and a tie-break that reads the current settings would make the answer depend on the
 * order somebody happened to press things in.
 */
function bestCombo(matrix: ModelMatrix): ComboKey | null {
  const timed = COMBO_KEYS.filter((key) => matrix[key].kind === 'ms');
  if (timed.length === 0) return null;
  const fastest = Math.min(...timed.map((key) => (matrix[key] as { ms: number }).ms));
  const contenders = timed.filter((key) => !clearlyFaster(fastest, (matrix[key] as { ms: number }).ms));
  const preference: ComboKey[] = ['gpu-gpu', 'cpu-gpu', 'gpu-cpu', 'cpu-cpu'];
  return preference.find((key) => contenders.includes(key)) ?? contenders[0];
}

/**
 * The gates that decide the model, and the brackets that colour the numbers.
 *
 * Two jobs, and since they are two sets of numbers they are allowed to disagree about the middle: a
 * small-model run can read "okay" and still leave no headroom for the larger one to be worth trying.
 * What they may not disagree about is the top — nothing should be coloured green that a gate then
 * refuses, which holds as long as each `good` stays at or under its gate.
 */
export const TRY_LARGE_BELOW_MS = 250;
export const KEEP_LARGE_BELOW_MS = 300;

export const BRACKETS = {
  motion: { good: 15, okay: 35 },
  inference: { good: 200, okay: 350 },
  inferenceLarge: { good: 200, okay: 350 },
} as const;

export function verdictFor(bracket: { good: number; okay: number }, ms: number): Verdict {
  if (ms < bracket.good) return 'good';
  if (ms < bracket.okay) return 'okay';
  return 'bad';
}

/**
 * How much better the CPU has to be before overriding a GPU path that works, *in the matrix*.
 *
 * Every figure there is an average over a busy device, so a millisecond either way is noise, and
 * flipping a stored setting on noise means two runs of the same self-test on one phone disagree.
 */
const MARGIN_MS = 2;
const MARGIN_RATIO = 0.05;

function clearlyFaster(cpuMs: number, gpuMs: number): boolean {
  return gpuMs - cpuMs > Math.max(MARGIN_MS, gpuMs * MARGIN_RATIO);
}

/**
 * The faster of two paths outright, ties going to the CPU. Used for the motion gate, and only there.
 *
 * **Deliberately not the margin-and-prefer-the-GPU rule the matrix uses**, because the motion gate
 * is not like the other stages: it runs ten times a second for as long as the camera is on, and what
 * it costs is not really its own time but time the GPU is then not spending on the work that
 * actually needs it. So a CPU pass that merely ties is the better answer — it leaves the whole GPU
 * to preprocessing and inference, where a frame's cost really lives — and a GPU pass has to be
 * genuinely faster to be worth taking that away.
 */
export function fasterPath(cpu: PathResult, gpu: PathResult): 'cpu' | 'gpu' {
  if (gpu.kind !== 'ms') return 'cpu';
  if (cpu.kind !== 'ms') return 'gpu';
  return cpu.ms <= gpu.ms ? 'cpu' : 'gpu';
}

/** Warmup is not measured: the first CPU motion pass has no previous frame and does less work. */
const MOTION_WARMUP_MS = 400;
const MOTION_MEASURE_MS = 1200;
/** Runs per cell of the matrix. Up to eight cells across two models, so this is the main cost. */
const MATRIX_RUNS = 5;

/** The photographs, and what the model is supposed to see in them. */
export interface ReferenceBoard {
  key: 'empty' | 'darts';
  url: string;
  /** Class 0–7 keypoints above threshold. Structurally at most 8 — one per board class. */
  boardKeypoints: number;
  /** Class 8 keypoints, after threshold and dedup. */
  tipKeypoints: number;
}

export const REFERENCE_BOARDS: ReferenceBoard[] = [
  { key: 'empty', url: '/reference/board-empty.jpg', boardKeypoints: 8, tipKeypoints: 0 },
  { key: 'darts', url: '/reference/board-three-darts.jpg', boardKeypoints: 8, tipKeypoints: 3 },
];

/** The four settings the self-test decides. Everything else about the device is left alone. */
export interface ChosenSettings {
  model: string;
  forceCpuMotion: boolean;
  forceCpuPreprocessing: boolean;
  forceCpuInference: boolean;
}

/**
 * Everything the self-test needs from the outside world.
 *
 * `loadRunner` is required to unload first, every time — `loadModel` caches by url and ignores the
 * requested accelerator on a cache hit, so without that a "CPU" measurement can quietly be the
 * WebGPU runner again. Unloading also clears the sticky latch that disables GPU preprocessing after
 * a single failure, so one hiccup cannot poison every later measurement. It is also where the
 * camera is re-opened at the model's capture size, which is why nothing below mentions resolution.
 *
 * **Two ways to run an inference, because they answer different questions.** `runCamera` is what a
 * frame really costs, measured through the stream the scoring screen will use. `runBoard` is the
 * only way to know the answer is *right*, and needs a picture whose answer is known.
 */
export interface OnboardingHarness {
  /** One motion analyzer pass, timed. Reports the path that actually ran. */
  motionPass(): Promise<{ ms: number; mode: string }>;
  /** Point the motion gate at one analyzer or the other, so both can be timed. */
  setMotionForceCpu(force: boolean): void;
  /** Unload whatever is loaded, then load this. Returns what actually came up. */
  loadRunner(model: string, forceCpuInference: boolean): Promise<{ accelerator: string }>;
  /** One inference on the live camera frame — a cell of the matrix. */
  runCamera(forceCpuPreprocessing: boolean): Promise<{ totalMs: number; preprocessMode: string }>;
  /** One inference on a reference photograph. Validation only; the timing is not wanted. */
  runBoard(board: ReferenceBoard, forceCpuPreprocessing: boolean): Promise<{ counts: Counts | null }>;
  /** Persist and apply a decision the moment it is made, so a cancelled run keeps what it proved. */
  apply(patch: Partial<ChosenSettings>): void;
  now(): number;
}

/** What `processPredictions` saw. Null from `runBoard` means it could not solve a homography. */
export interface Counts {
  boardKeypoints: number;
  tipKeypoints: number;
}

export interface StageOutcome {
  stage: 'motion' | 'model960' | 'model1280' | 'validation';
  /** Motion's two analyzers and which won. Null for the model stages and for validation. */
  paths: StagePaths | null;
  /** A model on every combination, and which one won. Null for the others. */
  matrix: { cells: ModelMatrix; selected: ComboKey | null } | null;
  verdict: Verdict | null;
  ok: boolean;
}

export type OnboardingEvent =
  | { kind: 'log'; text: string }
  | { kind: 'stage'; outcome: StageOutcome };

export interface OnboardingResult {
  stages: StageOutcome[];
  settings: ChosenSettings;
  /** False when the validation ladder ran out of rungs — the device may simply not be able to. */
  ok: boolean;
  /** Set when `ok` is false: what to tell somebody who cannot make this work. */
  failure?: string;
}

const mean = (xs: number[]) => xs.reduce((total, x) => total + x, 0) / xs.length;

/**
 * Run the whole thing.
 *
 * Decisions are applied through `harness.apply` as they are reached rather than all at the end,
 * which is what makes cancelling mid-run safe: whatever has already been proved about this device
 * stays proved. Leaving the screen should not throw away the discovery that its WebGPU is broken.
 */
export async function runOnboarding(
  harness: OnboardingHarness,
  onEvent: (event: OnboardingEvent) => void,
  start: ChosenSettings,
): Promise<OnboardingResult> {
  const chosen: ChosenSettings = { ...start };
  const stages: StageOutcome[] = [];

  const log = (text: string) => onEvent({ kind: 'log', text });
  const finish = (outcome: StageOutcome) => {
    stages.push(outcome);
    onEvent({ kind: 'stage', outcome });
  };
  const decide = (patch: Partial<ChosenSettings>, why: string) => {
    Object.assign(chosen, patch);
    harness.apply(patch);
    log(why);
  };

  // ── 1. The motion detector ──────────────────────────────────────
  // Runs on a canvas rather than a camera. The gate's cost does not depend on what it is looking
  // at — grey, blur, diff, count tiles happens per frame regardless — so a still picture measures
  // the same work a live one would.
  log('Measuring the motion detector…');
  const motionCpu = await measureMotion(harness, true);
  const motionGpu = await measureMotion(harness, false);
  const motionPick = fasterPath(motionCpu, motionGpu);

  decide(
    { forceCpuMotion: motionPick === 'cpu' },
    motionPick === 'cpu' ? 'Using the CPU motion detector.' : 'Using the GPU motion detector.',
  );
  finish({
    stage: 'motion',
    paths: { cpu: motionCpu, gpu: motionGpu, selected: motionPick },
    matrix: null,
    verdict: verdictOf(BRACKETS.motion, motionPick === 'cpu' ? motionCpu : motionGpu),
    ok: motionCpu.kind === 'ms' || motionGpu.kind === 'ms',
  });

  // ── 2 & 3. Each model, on every combination ─────────────────────
  //
  // One table rather than a preprocessing row and an inference row, because the two interact and
  // neither slice shows it. Holding one constant while varying the other can only ever say which is
  // better *given the other*, and the fastest pairing is not always the pairing of the two fastest.
  log('Timing the 960 px model…');
  const small = await measureMatrix(harness, 's_960');
  const smallBest = bestCombo(small);
  finish({
    stage: 'model960',
    paths: null,
    matrix: { cells: small, selected: smallBest },
    verdict: verdictOf(BRACKETS.inference, smallBest ? small[smallBest] : DNF),
    ok: smallBest !== null,
  });

  let chosenCombo = smallBest;
  const bestMs = msOf(small, smallBest);

  // The larger model is only worth its own table if the small one left headroom for it.
  if (bestMs < TRY_LARGE_BELOW_MS) {
    log(`The 960 px model runs in ${Math.round(bestMs)}ms — trying the larger one.`);
    const large = await measureMatrix(harness, 's_1280');
    const largeBest = bestCombo(large);
    const largeMs = msOf(large, largeBest);
    const keep = largeMs < KEEP_LARGE_BELOW_MS && largeBest !== null;

    finish({
      stage: 'model1280',
      paths: null,
      matrix: { cells: large, selected: largeBest },
      verdict: verdictOf(BRACKETS.inferenceLarge, largeBest ? large[largeBest] : DNF),
      ok: largeBest !== null,
    });

    // Both ways round, so the model is always something this run measured. Saying nothing when the
    // larger one loses would leave a device that arrived here on `s_1280` still on it.
    if (keep) chosenCombo = largeBest;
    decide(
      { model: keep ? 's_1280' : 's_960' },
      keep
        ? `The larger model runs in ${Math.round(largeMs)}ms — using it for the extra detail.`
        : 'The larger model is too slow here; staying on the 960 px one.',
    );
  } else {
    log('Staying on the 960 px model; there is no headroom for the larger one.');
  }

  // Both switches come from one cell, so they cannot be chosen in a way no run ever measured.
  if (chosenCombo) {
    const { preprocessing, inference } = comboOf(chosenCombo);
    decide(
      { forceCpuPreprocessing: preprocessing === 'cpu', forceCpuInference: inference === 'cpu' },
      `Preprocessing on the ${preprocessing.toUpperCase()}, inference on the ${inference.toUpperCase()}.`,
    );
  }

  // ── 4. Validation ───────────────────────────────────────────────
  // The stage this whole exercise exists for. Everything above is a measurement; this is the only
  // part that can tell a fast device from a fast device that is quietly returning nothing.
  log('Checking the results against two known boards…');

  for (const [index, rung] of rungsFrom(chosen).entries()) {
    if (index > 0) decide(rung.patch, rung.why);
    const failure = await validate(harness, chosen);
    if (!failure) {
      finish({
        stage: 'validation',
        paths: null,
        matrix: null,
        verdict: null,
        ok: true,
      });
      return { stages, settings: { ...chosen }, ok: true };
    }
    log(failure);
  }

  finish({ stage: 'validation', paths: null, matrix: null, verdict: null, ok: false });
  return {
    stages,
    settings: { ...chosen },
    ok: false,
    failure: 'This device could not read either reference board on any path. It may not be able to run the scoring model.',
  };
}

function verdictOf(bracket: { good: number; okay: number }, result: PathResult): Verdict | null {
  return result.kind === 'ms' ? verdictFor(bracket, result.ms) : null;
}

/** What the winning cell cost, or `Infinity` where nothing in the table finished. */
function msOf(matrix: ModelMatrix, key: ComboKey | null): number {
  const cell = key ? matrix[key] : DNF;
  return cell.kind === 'ms' ? cell.ms : Infinity;
}

/**
 * Time the motion gate on one analyzer.
 *
 * A `mode` that does not match what was asked for is a fallback, and a fallback is `dnf`: the
 * numbers collected came from the other path, and filing them under this one would invent a
 * measurement that never happened.
 */
async function measureMotion(harness: OnboardingHarness, forceCpu: boolean): Promise<PathResult> {
  harness.setMotionForceCpu(forceCpu);
  try {
    const warmupUntil = harness.now() + MOTION_WARMUP_MS;
    while (harness.now() < warmupUntil) await harness.motionPass();

    const samples: number[] = [];
    let mode = '';
    const measureUntil = harness.now() + MOTION_MEASURE_MS;
    while (harness.now() < measureUntil) {
      const pass = await harness.motionPass();
      samples.push(pass.ms);
      mode = pass.mode;
    }
    // The GPU analyzer calls itself `gpu-bitmap`; the CPU one, `cpu`.
    if (samples.length === 0 || (mode === 'cpu') !== forceCpu) return DNF;
    return took(mean(samples));
  } catch {
    return DNF;
  }
}

/**
 * The fallback ladder, as a list of things left to try.
 *
 * The first rung is doing nothing, because the configuration just measured is the one most likely to
 * work. The second is the one known to have rescued a real device: its WebGPU inference returned
 * empty results without ever reporting an error, and forcing the CPU fixed it outright. Rungs
 * already in force are dropped rather than re-tried — repeating a configuration that just failed
 * proves nothing and costs two more inferences.
 */
export function rungsFrom(chosen: ChosenSettings): { patch: Partial<ChosenSettings>; why: string }[] {
  const rungs: { patch: Partial<ChosenSettings>; why: string }[] = [{ patch: {}, why: '' }];
  if (!chosen.forceCpuInference) {
    rungs.push({
      patch: { forceCpuInference: true },
      why: 'Trying again with inference forced onto the CPU.',
    });
  }
  if (!chosen.forceCpuPreprocessing) {
    rungs.push({
      patch: { forceCpuInference: true, forceCpuPreprocessing: true },
      why: 'Trying again with preprocessing on the CPU as well.',
    });
  }
  return rungs;
}

/** Both boards through the current configuration. Returns null when both read correctly. */
async function validate(harness: OnboardingHarness, chosen: ChosenSettings): Promise<string | null> {
  await harness.loadRunner(chosen.model, chosen.forceCpuInference);
  for (const board of REFERENCE_BOARDS) {
    let counts: Counts | null;
    try {
      ({ counts } = await harness.runBoard(board, chosen.forceCpuPreprocessing));
    } catch {
      return `The ${board.key} board could not be read at all on this path.`;
    }
    // Null counts mean `processPredictions` could not solve a homography — fewer than four board
    // keypoints. That is the exact shape of the silent failure this stage is here to catch.
    if (!counts) return `The ${board.key} board produced no usable keypoints.`;
    if (counts.boardKeypoints !== board.boardKeypoints || counts.tipKeypoints !== board.tipKeypoints) {
      return `The ${board.key} board read ${counts.boardKeypoints} board points and ${counts.tipKeypoints} tips, expected ${board.boardKeypoints} and ${board.tipKeypoints}.`;
    }
  }
  return null;
}

/**
 * One model, on every combination of preprocessing and inference the code can produce.
 *
 * **One runner load per inference path, not one per cell.** Both preprocessing options are per-call
 * options on the same runner, so loading twice and running twice under each halves the model loads —
 * and a model load is by far the most expensive thing here.
 *
 * It also means nothing has to be probed in advance: a runner that comes up on the wrong accelerator
 * says so, and both of that column's cells stay `dnf` without either being attempted.
 */
async function measureMatrix(harness: OnboardingHarness, model: string): Promise<ModelMatrix> {
  const cells: ModelMatrix = { 'cpu-cpu': DNF, 'cpu-gpu': DNF, 'gpu-cpu': DNF, 'gpu-gpu': DNF };

  for (const inference of ['cpu', 'gpu'] as const) {
    const forceCpuInference = inference === 'cpu';
    let accelerator: string | null = null;
    try {
      ({ accelerator } = await harness.loadRunner(model, forceCpuInference));
    } catch {
      // Nothing came up at all; both cells of this column stay `dnf`.
    }
    // Asked for one accelerator and given the other: this whole column does not exist here.
    if (accelerator === null || (accelerator === 'wasm') !== forceCpuInference) continue;

    for (const preprocessing of ['cpu', 'gpu'] as const) {
      cells[`${preprocessing}-${inference}`] = await cell(harness, preprocessing === 'cpu');
    }
  }
  return cells;
}

/**
 * One cell: an unmeasured warmup run, then `MATRIX_RUNS` measured ones on the runner already loaded.
 *
 * A preprocessing path that reports something other than what was asked for is `dnf`, not a number:
 * the figures would have come from the other path, and filing them here would invent a measurement
 * that never happened.
 */
async function cell(harness: OnboardingHarness, forceCpuPreprocessing: boolean): Promise<PathResult> {
  try {
    await harness.runCamera(forceCpuPreprocessing);
    const totals: number[] = [];
    let preprocessMode = '';
    for (let i = 0; i < MATRIX_RUNS; i++) {
      const result = await harness.runCamera(forceCpuPreprocessing);
      totals.push(result.totalMs);
      preprocessMode = result.preprocessMode;
    }
    if ((preprocessMode !== 'gpu-bitmap') !== forceCpuPreprocessing) return DNF;
    return took(mean(totals));
  } catch {
    return DNF;
  }
}
