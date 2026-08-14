// Setting a phone up: what it can do, and what that means for its settings.
//
// Built as a **step shell** with one step in it. That is deliberate — more setup steps are coming,
// and a screen written as "the self-test" would have to be taken apart to accept a second one,
// where a screen written as "step 1 of n" only has to be added to.
//
// Nothing starts on its own. Somebody arrives here, reads what is about to happen, and presses a
// button; a phone that opens a screen and immediately seizes its GPU for twenty seconds is a phone
// that looks broken.

import { useState } from 'react';
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
import { saveSettings, type ScorerSettings } from '../../lib/scorerStorage';

interface OnboardingViewProps {
  settings: ScorerSettings;
  onSettingsChange: (settings: ScorerSettings) => void;
  /** Leave, however it ended. The caller marks the device onboarded and reloads. */
  onDone: () => void;
}

type Phase = 'intro' | 'running' | 'finished';

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
  const [phase, setPhase] = useState<Phase>('intro');
  /** Only the newest line is ever shown, so only the newest line is kept. */
  const [log, setLog] = useState('');
  const [stages, setStages] = useState<StageOutcome[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

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
      harness = await createOnboardingHarness(apply);
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
        {/* Step 1 of 1 today. The counter is here so the second step is an addition rather than a
            redesign, and so somebody can see there is an end to this. */}
        <p className="text-xs text-gray-500">Step 1 of 1 · Checking what this device can do</p>
      </header>

      {phase === 'intro' && (
        <>
          <p className="text-sm text-gray-400">
            This measures how fast this phone can watch a board, then reads two photographs whose
            answers are already known — so it can pick the right settings, and tell you if something
            here does not work at all.
          </p>
          <p className="text-sm text-gray-500">It takes about half a minute. The camera stays off.</p>
          <div className="flex gap-2">
            <button
              onClick={() => void start()}
              className="px-4 py-2 bg-green-700 hover:bg-green-600 rounded font-semibold transition-colors"
            >
              Start
            </button>
            <button
              onClick={onDone}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded transition-colors"
            >
              Skip
            </button>
          </div>
        </>
      )}

      {phase !== 'intro' && (
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

          {/* One button that changes its word, rather than two that come and go.

              Leaving is available *during* the run: this holds the GPU for half a minute, and
              somebody who would rather be scoring should not have to wait it out. Whatever has
              already been measured stays applied — see `onDone`.

              It is one element because the run can finish while a finger is on the way down. Two
              buttons meant the one being reached for was removed mid-tap and the tap landed on
              nothing, which is also what made this flaky to test. */}
          <button
            onClick={onDone}
            data-testid="onboarding-leave"
            className="self-start px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
          >
            {phase === 'running' ? 'Skip' : 'Done'}
          </button>
        </>
      )}
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
