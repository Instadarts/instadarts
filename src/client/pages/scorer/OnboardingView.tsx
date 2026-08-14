// Setting a phone up: which camera, what it can do, and what that means for its settings.
//
// A **step shell**. Two steps today — choose a camera, then measure the device through it — and the
// shell is what lets a third be an addition rather than a redesign.
//
// Nothing measures on its own. The camera opens when somebody allows it, and the checks start when
// somebody presses the button that says so; a phone that opens a screen and immediately seizes its
// GPU for half a minute is a phone that looks broken.

import { useEffect, useState } from 'react';
import {
  DNF,
  runOnboarding,
  type ChosenSettings,
  type ComboKey,
  type ModelMatrix,
  type OnboardingEvent,
  type PathResult,
  type StageOutcome,
  type Verdict,
} from '../../lib/onboarding';
import { createOnboardingHarness } from '../../lib/onboardingHarness';
import { useOnboardingCamera } from '../../hooks/useOnboardingCamera';
import { saveSettings, type ScorerSettings } from '../../lib/scorerStorage';
import { CameraStep } from './CameraStep';

interface OnboardingViewProps {
  settings: ScorerSettings;
  onSettingsChange: (settings: ScorerSettings) => void;
  /** Leave, however it ended. The caller marks the device onboarded and reloads. */
  onDone: () => void;
}

/** Where the flow is. `camera` is step one; the other two are step two before and during results. */
type Phase = 'camera' | 'running' | 'finished';

const STEP_LABEL: Record<Phase, string> = {
  camera: 'Step 1 of 2 · Choosing a camera',
  running: 'Step 2 of 2 · Checking what this device can do',
  finished: 'Step 2 of 2 · Checking what this device can do',
};

const VERDICT_COLOUR: Record<Verdict, string> = {
  good: 'text-green-400',
  okay: 'text-yellow-400',
  bad: 'text-red-400',
};

const STAGE_LABEL: Record<StageOutcome['stage'], string> = {
  motion: 'Motion detector',
  model960: '960 px model',
  model1280: '1280 px model',
  validation: 'Reading a real board',
};

export function OnboardingView({ settings, onSettingsChange, onDone }: OnboardingViewProps) {
  const [phase, setPhase] = useState<Phase>('camera');
  /** Only the newest line is ever shown, so only the newest line is kept. */
  const [log, setLog] = useState('');
  const [stages, setStages] = useState<StageOutcome[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const camera = useOnboardingCamera();

  // The permission question is asked once, on arrival, and answers itself where access is already
  // granted. `dispose` on the way out is belt and braces — leaving reloads the page — but a camera
  // left running because a component unmounted is not a thing to leave to chance.
  const { begin, dispose } = camera;
  useEffect(() => {
    void begin();
    return dispose;
  }, [begin, dispose]);

  // The `settings` prop changes underneath this as decisions are applied, but nothing here reads it
  // again after the run starts — the starting configuration is taken once, at the top.
  async function start() {
    setPhase('running');

    const onEvent = (event: OnboardingEvent) => {
      if (event.kind === 'log') setLog(event.text);
      if (event.kind === 'stage') setStages((all) => [...all, event.outcome]);
    };

    // Decisions are written through as they are made rather than collected to the end, which is what
    // makes leaving half way through safe: whatever this device has already proved stays proved.
    const apply = (patch: Partial<ChosenSettings>) => onSettingsChange(saveSettings(patch));

    let harness: Awaited<ReturnType<typeof createOnboardingHarness>> | null = null;
    try {
      const handle = camera.handle();
      if (!handle) throw new Error('The camera stopped before the checks could start.');
      harness = await createOnboardingHarness(apply, handle);
      // `ScorerSettings` is a superset of the four the self-test decides, so it *is* a starting
      // configuration; nothing over there can reach the rest.
      const result = await runOnboarding(harness, onEvent, settings);
      if (!result.ok) setFailure(result.failure ?? 'This device could not be set up.');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      await harness?.dispose();
      setPhase('finished');
    }
  }

  return (
    <div className="w-full max-w-md flex flex-col gap-3 p-4">
      <header>
        <h2 className="text-lg font-semibold text-green-400">Setting up this camera</h2>
        {/* A counter, so somebody can see there is an end to this — and so the day a third step
            arrives it is a line to edit rather than a screen to rethink. */}
        <p className="text-xs text-gray-500">{STEP_LABEL[phase]}</p>
      </header>

      {/* The preview belongs to the whole screen, not to the step that introduces it. It is the
          element the benchmark reads its frames out of, so unmounting it when the step changes
          would hand the harness a detached video half way through — and it is worth seeing during
          the run anyway, since that is the camera being measured.

          **The box is always there and always square**, with the video laid inside it rather than
          sizing it. A `<video>` is sized by the stream in it, so it collapses to nothing while there
          is none — which threw everything below it up the screen when the camera opened, and again
          every time the model change re-opened it at 1280. Capture is square at the model's input
          size, so a square box fits every stream this will ever hold. */}
      <div className="relative w-full aspect-square rounded overflow-hidden bg-gray-950 border border-gray-800">
        <video
          ref={camera.videoRef}
          playsInline
          muted
          autoPlay
          data-testid="onboarding-preview"
          className="absolute inset-0 w-full h-full object-cover"
        />
        {camera.phase !== 'ready' && (
          <span className="absolute inset-0 flex items-center justify-center text-sm text-gray-600">
            Camera preview
          </span>
        )}
      </div>

      {phase === 'camera' && <CameraStep camera={camera} onContinue={() => void start()} />}

      {phase !== 'camera' && (
        <>
          {/* Which model row is in bold is read from the live settings rather than carried on the
              stage, because it is not knowable when a stage finishes: the 960 px row is the choice
              right up until the 1280 px one beats it, and then it is not. */}
          <ol className="flex flex-col gap-1" data-testid="onboarding-stages">
            {stages.map((stage) => (
              <StageRow
                key={stage.stage}
                stage={stage}
                chosen={stage.stage === (settings.model === 's_1280' ? 'model1280' : 'model960')}
              />
            ))}
          </ol>

          {/* Two lines' worth of fixed height, and clamped to two: most of these messages wrap on a
              phone, and a taller one used to run underneath the button below rather than move it.
              Fixed rather than automatic so the panel does not jump every time the message changes,
              and cleared once there is a verdict — "Checking the results…" sitting under "Ready"
              reads as a screen that has lost track of itself. */}
          <p className="text-sm text-gray-400 h-10 line-clamp-2" data-testid="onboarding-log">
            {phase === 'running' ? log : ''}
          </p>

          {phase === 'finished' && (
            <p className={`text-sm ${failure ? 'text-red-400' : 'text-green-400'}`} data-testid="onboarding-verdict">
              {failure ?? `Ready. Using the ${settings.model === 's_1280' ? '1280' : '960'} px model${describeOverrides(settings)}.`}
            </p>
          )}
        </>
      )}

      {/* One button, on every step, that changes its word rather than coming and going.

          Leaving is available throughout — before the camera is allowed, *during* the run, and at
          the end. A phone with no camera, or whose owner will not grant one, cannot finish setup and
          must still be able to leave it; and somebody who would rather be scoring should not have to
          sit out half a minute of benchmark. Whatever has already been measured stays applied.

          It is one element because the run can finish while a finger is on the way down. Two buttons
          meant the one being reached for was removed mid-tap and the tap landed on nothing, which is
          also what made this flaky to test. */}
      <button
        onClick={onDone}
        data-testid="onboarding-leave"
        className="self-start px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
      >
        {phase === 'finished' ? 'Done' : 'Skip'}
      </button>
    </div>
  );
}

/**
 * One stage: a headline anybody can read, and the working behind it a tap away.
 *
 * Collapsed, this is the answer — what the winning path cost, coloured by how good that is. Somebody
 * setting a phone up wants to know it worked and roughly how well; a table of four numbers, three of
 * which describe paths that were not taken, is a diagnostic. Expanded, it is exactly that table.
 */
function StageRow({ stage, chosen }: { stage: StageOutcome; chosen: boolean }) {
  const [open, setOpen] = useState(false);
  const colour = stage.ok
    ? stage.verdict
      ? VERDICT_COLOUR[stage.verdict]
      : 'text-green-400'
    : 'text-red-400';

  const headline = headlineOf(stage);
  const details = stage.paths ?? stage.matrix;

  return (
    <li data-testid={`stage-${stage.stage}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        // Validation has nothing behind it: one line is the whole result.
        disabled={!details}
        aria-expanded={details ? open : undefined}
        className="w-full flex items-baseline justify-between gap-2 text-sm text-left"
      >
        <span className={chosen ? 'font-bold text-gray-200' : 'text-gray-300'}>
          {details && <span className="text-gray-600">{open ? '▾ ' : '▸ '}</span>}
          {STAGE_LABEL[stage.stage]}
        </span>
        <span className={`font-mono text-xs ${colour}`}>
          {headline ? textFor(headline) : stage.ok ? 'ok' : 'failed'}
        </span>
      </button>

      {open && stage.paths && (
        <p className="ml-3 mt-0.5 font-mono text-xs">
          <Timing label="cpu" result={stage.paths.cpu} selected={stage.paths.selected === 'cpu'} colour={colour} />
          <span className="text-gray-600"> | </span>
          <Timing label="gpu" result={stage.paths.gpu} selected={stage.paths.selected === 'gpu'} colour={colour} />
        </p>
      )}
      {open && stage.matrix && <Matrix cells={stage.matrix.cells} selected={stage.matrix.selected} colour={colour} />}
    </li>
  );
}

/**
 * The one number a stage is worth, which is what its winning path cost.
 *
 * Null where there is no number to give — validation, which either read the boards or did not. It is
 * the same result the verdict was computed from, so the figure and its colour cannot disagree.
 */
function headlineOf(stage: StageOutcome): PathResult | null {
  if (stage.paths) return stage.paths[stage.paths.selected];
  if (stage.matrix) return stage.matrix.selected ? stage.matrix.cells[stage.matrix.selected] : DNF;
  return null;
}

const textFor = (result: PathResult) => (result.kind === 'ms' ? `${Math.round(result.ms)}ms` : 'dnf');

/**
 * A model on all four combinations of preprocessing and inference.
 *
 * A table rather than two rows of "which path won", because the two interact: the fastest pairing is
 * not always the pairing of the two individually fastest, and holding one constant while varying the
 * other can only say which is better *given* the other. Four numbers say it outright.
 */
function Matrix({ cells, selected, colour }: { cells: ModelMatrix; selected: ComboKey | null; colour: string }) {
  const row = (pre: 'cpu' | 'gpu') => (
    <>
      <span className="text-gray-500">pre {pre}</span>
      {(['cpu', 'gpu'] as const).map((inf) => {
        const key = `${pre}-${inf}` as ComboKey;
        return <Timing key={key} result={cells[key]} selected={selected === key} colour={colour} align="text-right" />;
      })}
    </>
  );

  return (
    <div className="ml-3 mt-0.5 grid grid-cols-[1fr_4rem_4rem] gap-x-2 text-xs font-mono" data-testid="stage-matrix">
      <span />
      <span className="text-right text-gray-500">inf cpu</span>
      <span className="text-right text-gray-500">inf gpu</span>
      {row('cpu')}
      {row('gpu')}
    </div>
  );
}

/**
 * One measured path — `10ms`, or `dnf` where it was tried and did not work.
 *
 * The chosen one is bold and carries the stage's colour; the rest stay muted, because they are
 * context rather than the answer. All of them are always shown: a stage that reported only its
 * winner is exactly what left somebody unable to tell a broken GPU from one that lost a fair race.
 */
function Timing({ label, result, selected, colour, align = '' }: {
  label?: string;
  result: PathResult;
  selected: boolean;
  colour: string;
  align?: string;
}) {
  return (
    <span
      className={`${align} ${selected ? `font-bold ${colour}` : 'text-gray-500'}`}
      title={result.kind === 'dnf' ? 'did not finish — this path was tried and failed' : undefined}
    >
      {label ? `${label}: ` : ''}
      {textFor(result)}
    </span>
  );
}

/** The short version of what was turned on, for somebody who will never open the diagnostics block. */
function describeOverrides(settings: ScorerSettings): string {
  const forced = [
    settings.forceCpuMotion && 'motion',
    settings.forceCpuPreprocessing && 'preprocessing',
    settings.forceCpuInference && 'inference',
  ].filter(Boolean);
  if (forced.length === 0) return '';
  return `, with ${forced.join(', ')} on the CPU`;
}
