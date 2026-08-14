// The self-test's decisions, against a harness that lies on demand.
//
// Everything real about onboarding — the model, the GPU, the canvas, the photographs — is behind
// `OnboardingHarness`, so what is exercised here is the part that has opinions: which path to keep,
// which model, which override to flip, and how far down the fallback ladder to walk before giving
// up. None of it needs a browser, which matters because the paths being decided about are exactly
// the ones CI has no hardware for.

import { describe, it, expect } from 'vitest';
import {
  runOnboarding,
  rungsFrom,
  fasterPath,
  verdictFor,
  took,
  DNF,
  BRACKETS,
  TRY_LARGE_BELOW_MS,
  KEEP_LARGE_BELOW_MS,
  REFERENCE_BOARDS,
  type ChosenSettings,
  type OnboardingHarness,
  type OnboardingEvent,
  type StageOutcome,
} from '../../src/client/lib/onboarding';

const DEFAULTS: ChosenSettings = {
  model: 's_960',
  forceCpuMotion: false,
  forceCpuPreprocessing: false,
  forceCpuInference: false,
};

/** What a device does, expressed as the answers its harness gives. */
interface Device {
  /** Motion cost per path. `unavailable` means the GPU analyzer quietly gives way to the CPU. */
  motion?: { cpu: number; gpu: number | 'unavailable' };
  /** Inference cost per model, on the GPU. */
  inference?: Record<string, number>;
  /** What the CPU costs relative to the GPU, for the same model. */
  cpuInferenceFactor?: number;
  /** What `loadRunner` reports. A device with no working WebGPU says `wasm` whatever it is asked. */
  accelerator?: (model: string, forceCpu: boolean) => string;
  preprocess?: { gpu: number | 'throws'; cpu: number };
  /** GPU preprocessing is unavailable while inference is on the CPU (no device to borrow). */
  noGpuPreprocessOnCpuInference?: boolean;
  /** GPU preprocessing is asked for and quietly gives way — the sticky latch inside the runner. */
  gpuPreprocessFallsBack?: boolean;
  /** Which configurations read the boards correctly. Default: all of them. */
  reads?: (chosen: ChosenSettings) => boolean;
}

function fakeHarness(device: Device) {
  const applied: Partial<ChosenSettings>[] = [];
  const chosen: ChosenSettings = { ...DEFAULTS };
  const loads: { model: string; forceCpuInference: boolean }[] = [];
  /** Which photographs validation actually put through the model. */
  const boardsRead: string[] = [];
  let clock = 0;
  let motionForcedCpu = false;
  let accelerator = 'webgpu';
  let loadedCpu = false;

  const harness: OnboardingHarness = {
    setMotionForceCpu(force) {
      motionForcedCpu = force;
    },
    async motionPass() {
      clock += 60; // so the warmup and measure windows terminate
      const costs = device.motion ?? { cpu: 8, gpu: 4 };
      // Asked for the GPU on a device that has none: the gate falls back and says so, which is what
      // the real analyzer does and the only way the caller can tell.
      if (!motionForcedCpu && costs.gpu === 'unavailable') return { ms: costs.cpu, mode: 'cpu' };
      return motionForcedCpu
        ? { ms: costs.cpu, mode: 'cpu' }
        : { ms: costs.gpu as number, mode: 'gpu-bitmap' };
    },
    async loadRunner(model, forceCpuInference) {
      loads.push({ model, forceCpuInference });
      chosen.model = model;
      loadedCpu = forceCpuInference;
      accelerator = device.accelerator?.(model, forceCpuInference) ?? (forceCpuInference ? 'wasm' : 'webgpu');
      return { accelerator };
    },
    // One inference, whatever it is pointed at. Both harness methods go through this, because every
    // way a device can fail — a GPU preprocessor that is not there, one that quietly gives way —
    // fails the same way for a camera frame and for a photograph.
    async runCamera(forceCpuPreprocessing) {
      const pre = device.preprocess ?? { gpu: 2, cpu: 6 };
      if (!forceCpuPreprocessing && pre.gpu === 'throws') throw new Error('no webgpu preprocessing');
      if (!forceCpuPreprocessing && loadedCpu && device.noGpuPreprocessOnCpuInference) {
        throw new Error('no webgpu device while running on the cpu');
      }
      const preMs = forceCpuPreprocessing ? pre.cpu : (pre.gpu as number);
      const base = device.inference?.[chosen.model] ?? 100;
      const inferenceMs = loadedCpu ? base * (device.cpuInferenceFactor ?? 1) : base;
      const ranOnGpu = !forceCpuPreprocessing && !device.gpuPreprocessFallsBack;
      return { totalMs: inferenceMs + preMs, preprocessMode: ranOnGpu ? 'gpu-bitmap' : 'cpu' };
    },
    async runBoard(board, forceCpuPreprocessing) {
      await harness.runCamera(forceCpuPreprocessing);
      boardsRead.push(board.key);
      const ok = device.reads ? device.reads(chosen) : true;
      return { counts: ok ? { boardKeypoints: board.boardKeypoints, tipKeypoints: board.tipKeypoints } : null };
    },
    apply(patch) {
      applied.push(patch);
      Object.assign(chosen, patch);
    },
    now: () => clock,
  };

  return { harness, applied, loads, boardsRead };
}

async function run(device: Device, start: ChosenSettings = DEFAULTS) {
  const { harness, applied, loads, boardsRead } = fakeHarness(device);
  const events: OnboardingEvent[] = [];
  const result = await runOnboarding(harness, (e) => events.push(e), start);
  const stage = (name: StageOutcome['stage']) => result.stages.find((s) => s.stage === name)!;
  return { result, applied, loads, boardsRead, events, stage };
}

/** A device with no working WebGPU at all — the headless-CI shape. */
const NO_GPU: Device = { accelerator: () => 'wasm', motion: { cpu: 8, gpu: 'unavailable' } };

describe('verdicts and path selection', () => {
  it('brackets a number into good, okay and bad', () => {
    expect(verdictFor(BRACKETS.motion, BRACKETS.motion.good - 1)).toBe('good');
    expect(verdictFor(BRACKETS.motion, BRACKETS.motion.good)).toBe('okay');
    expect(verdictFor(BRACKETS.motion, BRACKETS.motion.okay - 1)).toBe('okay');
    expect(verdictFor(BRACKETS.motion, BRACKETS.motion.okay)).toBe('bad');
  });

  it('never colours a reading green that the model gates then refuse', () => {
    // The brackets colour and the gates decide, and they are separate numbers — an "okay" run of the
    // small model may still be too slow for the larger one to be worth trying, which is a fair thing
    // to say. Calling a configuration good and then refusing it is not.
    expect(BRACKETS.inference.good).toBeLessThanOrEqual(TRY_LARGE_BELOW_MS);
    expect(BRACKETS.inferenceLarge.good).toBeLessThanOrEqual(KEEP_LARGE_BELOW_MS);
  });

  it('gives the motion gate to whichever path is faster, ties included', () => {
    // No noise margin and no preference for the GPU, unlike the matrix below. The gate runs ten
    // times a second for as long as the camera is on, so a GPU that only draws is a GPU held away
    // from the model for nothing.
    expect(fasterPath(took(20), took(21))).toBe('cpu');
    expect(fasterPath(took(21), took(20))).toBe('gpu');
    expect(fasterPath(took(10), took(10))).toBe('cpu');
    expect(fasterPath(took(10), DNF)).toBe('cpu');
    expect(fasterPath(DNF, took(10))).toBe('gpu');
  });
});

describe('the motion detector', () => {
  it('times both analyzers and keeps the faster', async () => {
    const { stage, result } = await run({ motion: { cpu: 20, gpu: 5 } });
    expect(stage('motion').paths).toEqual({ cpu: took(20), gpu: took(5), selected: 'gpu' });
    expect(result.settings.forceCpuMotion).toBe(false);
  });

  it('reports the GPU as dnf when it quietly gives way, rather than as a slow number', async () => {
    // The case that sent somebody looking in the wrong place: a fallback reports mode `cpu`, so the
    // figures collected under "gpu" came from the CPU. Filing them as a GPU measurement would invent
    // a race the GPU never ran in.
    const { stage, result } = await run({ motion: { cpu: 8, gpu: 'unavailable' } });
    expect(stage('motion').paths).toEqual({ cpu: took(8), gpu: DNF, selected: 'cpu' });
    expect(result.settings.forceCpuMotion).toBe(true);
  });

  it('picks the CPU when it is faster, and says both numbers', async () => {
    const { stage, result } = await run({ motion: { cpu: 4, gpu: 30 } });
    expect(stage('motion').paths).toEqual({ cpu: took(4), gpu: took(30), selected: 'cpu' });
    expect(result.settings.forceCpuMotion).toBe(true);
  });

  it('leaves the GPU alone when the two analyzers are close', async () => {
    // The matrix would keep the GPU here — a millisecond is inside its noise margin. Motion does
    // not, because the cost that matters is what the gate denies the model, not what it spends.
    const { stage, result } = await run({ motion: { cpu: 20, gpu: 21 } });
    expect(stage('motion').paths).toMatchObject({ selected: 'cpu' });
    expect(result.settings.forceCpuMotion).toBe(true);
  });

  it('times motion without loading a model first', async () => {
    // The gate needs a WebGPU device, not a model — and the harness guarantees LiteRT is up before
    // it builds the gate, which is what makes the device exist. Nothing here should be waiting on a
    // model load, and an ordering that quietly depends on one is how the GPU analyzer came to be
    // reported as broken on hardware where it works.
    const order: string[] = [];
    const { harness } = fakeHarness({});
    const load = harness.loadRunner.bind(harness);
    const pass = harness.motionPass.bind(harness);
    harness.loadRunner = async (m, f) => { order.push('load'); return load(m, f); };
    harness.motionPass = async () => { order.push('motion'); return pass(); };
    await runOnboarding(harness, () => {}, DEFAULTS);
    expect(order[0]).toBe('motion');
  });
});

describe('the model matrices', () => {
  const cellsOf = (result: { stages: StageOutcome[] }, stage: 'model960' | 'model1280') =>
    result.stages.find((s) => s.stage === stage)!.matrix!.cells;

  it('times all four combinations of preprocessing and inference', async () => {
    // The point of a table rather than two rows: the two interact, and the fastest pairing is not
    // always the pairing of the two individually fastest.
    const { result } = await run({ preprocess: { gpu: 2, cpu: 20 }, inference: { s_960: 100 }, cpuInferenceFactor: 3 });
    expect(cellsOf(result, 'model960')).toEqual({
      'cpu-cpu': took(320),  // 300 cpu inference + 20 cpu preprocessing
      'gpu-cpu': took(302),  // 300 cpu inference +  2 gpu preprocessing
      'cpu-gpu': took(120),  // 100 gpu inference + 20 cpu preprocessing
      'gpu-gpu': took(102),  // 100 gpu inference +  2 gpu preprocessing
    });
  });

  it('picks the fastest cell, and sets both switches from that one cell', async () => {
    // Both come from one measured combination, so they cannot end up in a pairing nothing ran.
    const { result } = await run({ preprocess: { gpu: 40, cpu: 2 }, inference: { s_960: 100 }, cpuInferenceFactor: 3 });
    expect(result.settings.forceCpuPreprocessing).toBe(true);
    expect(result.settings.forceCpuInference).toBe(false);
  });

  it('reports gpu inference as dnf on a device that has none, for both preprocessing paths', async () => {
    const { result } = await run(NO_GPU);
    const cells = cellsOf(result, 'model960');
    expect(cells['cpu-gpu']).toEqual(DNF);
    expect(cells['gpu-gpu']).toEqual(DNF);
    // But GPU preprocessing feeding the CPU model is its own question, and gets its own answer.
    expect(cells['cpu-cpu'].kind).toBe('ms');
  });

  it('reports dnf for gpu preprocessing under cpu inference where there is no device to borrow', async () => {
    const { result } = await run({ ...NO_GPU, noGpuPreprocessOnCpuInference: true });
    const cells = cellsOf(result, 'model960');
    expect(cells['gpu-cpu']).toEqual(DNF);
    expect(cells['cpu-cpu'].kind).toBe('ms');
  });

  it('reports dnf when the GPU preprocessor is asked for and quietly gives way', async () => {
    const { result } = await run({ gpuPreprocessFallsBack: true });
    const cells = cellsOf(result, 'model960');
    expect(cells['gpu-gpu']).toEqual(DNF);
    expect(cells['gpu-cpu']).toEqual(DNF);
  });

  it('gives the larger model a table of its own when it is worth trying', async () => {
    const { result } = await run({ inference: { s_960: 40, s_1280: 90 } });
    expect(cellsOf(result, 'model1280')['gpu-gpu'].kind).toBe('ms');
    expect(result.settings.model).toBe('s_1280');
  });

  it('moves a device back to the smaller model when the larger one does not earn its place', async () => {
    // Both ways round, not just "upgrade when it fits": a phone that arrives here already on the
    // large model and cannot run it must leave on the small one, or the self-test has measured
    // something and then left the device set to the thing it measured as too slow.
    const start = { ...DEFAULTS, model: 's_1280' };
    const { result } = await run({ inference: { s_960: 40, s_1280: 400 } }, start);
    expect(result.settings.model).toBe('s_960');
  });
});

describe('the validation ladder', () => {
  it('stops at the first rung when the measured configuration already reads both boards', async () => {
    const { result, applied } = await run({});
    expect(result.ok).toBe(true);
    expect(applied.some((p) => p.forceCpuInference)).toBe(false);
  });

  it('rescues the device whose webgpu inference silently returns nothing', async () => {
    // The real case this exists for: no error, no exception, empty results — until inference is
    // forced onto the CPU, where the same model reads both boards perfectly.
    const { result } = await run({ reads: (c) => c.forceCpuInference });
    expect(result.ok).toBe(true);
    expect(result.settings.forceCpuInference).toBe(true);
  });

  it('walks on to preprocessing when forcing inference alone is not enough', async () => {
    const { result } = await run({ reads: (c) => c.forceCpuInference && c.forceCpuPreprocessing });
    expect(result.ok).toBe(true);
    expect(result.settings.forceCpuPreprocessing).toBe(true);
  });

  it('gives up honestly when no rung works, rather than claiming success', async () => {
    const { result } = await run({ reads: () => false });
    expect(result.ok).toBe(false);
    expect(result.failure).toMatch(/may not be able to run/i);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'validation', ok: false });
  });

  it('does not re-try a configuration that is already in force', async () => {
    expect(rungsFrom({ ...DEFAULTS, forceCpuInference: true, forceCpuPreprocessing: true })).toHaveLength(1);
    expect(rungsFrom({ ...DEFAULTS, forceCpuInference: true })).toHaveLength(2);
    expect(rungsFrom(DEFAULTS)).toHaveLength(3);
  });

  it('checks both boards, not just the interesting one', async () => {
    // A device that reads darts but not an empty board is broken in a way that would score phantom
    // darts all evening, so the empty board is not optional.
    const { boardsRead } = await run({});
    expect(new Set(boardsRead)).toEqual(new Set(REFERENCE_BOARDS.map((b) => b.key)));
  });

  it('validates against the photographs, never against what the camera can see', async () => {
    // The camera is what the *timings* are measured through — it is the real pipeline. It is worth
    // nothing as a check of correctness, because nobody knows what it is pointed at. So the boards
    // are the only thing validation is allowed to read, and this is the seam that enforces it.
    const { boardsRead } = await run({});
    expect(boardsRead.length).toBe(REFERENCE_BOARDS.length);
  });
});

describe('applying decisions as they are made', () => {
  it('persists each decision when it is reached, so cancelling keeps what was proved', async () => {
    // Not batched to the end: somebody who leaves half way through should still benefit from the
    // discovery that this device's WebGPU inference does not work.
    const { applied } = await run(NO_GPU);
    expect(applied).toContainEqual({ forceCpuMotion: true });
    // Both compute switches arrive together, from the one cell of the table that won — they can
    // never be left in a pairing no run ever measured.
    expect(applied).toContainEqual({ forceCpuInference: true, forceCpuPreprocessing: false });
  });

  it('reports every stage in order, each carrying its own numbers', async () => {
    // The large model earns a table of its own when it is tried, rather than a footnote on the
    // small model's: it is a different model with four different numbers.
    const { result } = await run({});
    expect(result.stages.map((s) => s.stage)).toEqual(['motion', 'model960', 'model1280', 'validation']);

    // Motion is a straight two-way race; the model stages are tables; validation is neither.
    expect(result.stages[0].paths).not.toBeNull();
    for (const stage of result.stages.slice(1, 3)) {
      expect(stage.matrix, `${stage.stage} should report a matrix`).not.toBeNull();
      expect(Object.keys(stage.matrix!.cells).sort()).toEqual(['cpu-cpu', 'cpu-gpu', 'gpu-cpu', 'gpu-gpu']);
    }
    expect(result.stages[3].paths).toBeNull();
    expect(result.stages[3].matrix).toBeNull();
  });
});
