// Setting a phone up: what to call it, which camera, what it can do, and what that means for its
// settings.
//
// A **step shell**, three steps deep. It was written as one before there was a second, which is what
// let the second and third be additions rather than redesigns.
//
// Nothing happens on its own. The camera is not asked for until somebody has finished naming the
// device, and the checks do not start until somebody presses the button that says so; a phone that
// opens a screen and immediately raises a permission dialog, or seizes its GPU for half a minute, is
// a phone that looks broken.

import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Center,
  Collapse,
  Group,
  Stack,
  Table,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
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
import { useAimPreview } from '../../hooks/useAimPreview';
import { AimStep } from './AimStep';
import { BoardOverlay } from './BoardOverlay';
import { CameraStep } from './CameraStep';
import { NameStep } from './NameStep';
import { AppCard } from '../../components/AppCard';
import { SquareCameraPreview } from './SquareCameraViewport';

interface OnboardingViewProps {
  settings: ScorerSettings;
  onSettingsChange: (settings: ScorerSettings) => void;
  /** What this device is called, and the same two callbacks the scoring screen's field uses. */
  name: string;
  onRename: (name: string) => void;
  onNameSettled: () => void;
  /** Leave, however it ended. The caller marks the device onboarded and reloads. */
  onDone: () => void;
}

/** Where the flow is. `running` and `finished` are one step, before and after the checks have run. */
type Step = 'name' | 'camera' | 'running' | 'finished' | 'aim';

const STEP_LABEL: Record<Step, string> = {
  name: 'Step 1 of 4 · Naming this device',
  camera: 'Step 2 of 4 · Choosing a camera',
  running: 'Step 3 of 4 · Checking what this device can do',
  finished: 'Step 3 of 4 · Checking what this device can do',
  aim: 'Step 4 of 4 · Pointing it at a board',
};

const VERDICT_COLOUR: Record<Verdict, string> = {
  good: 'green.4',
  okay: 'yellow.4',
  bad: 'red.4',
};

const STAGE_LABEL: Record<StageOutcome['stage'], string> = {
  motion: 'Motion detector',
  model960: '960 px model',
  model1280: '1280 px model',
  validation: 'Validating model output',
};

export function OnboardingView({ settings, onSettingsChange, name, onRename, onNameSettled, onDone }: OnboardingViewProps) {
  const [step, setStep] = useState<Step>('name');
  /** Only the newest line is ever shown, so only the newest line is kept. */
  const [log, setLog] = useState('');
  const [stages, setStages] = useState<StageOutcome[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const camera = useOnboardingCamera();

  // Asked for when the camera step is reached and not before, so nobody is answering a permission
  // dialog while they are still typing a name. It answers itself where access is already granted.
  const { begin, dispose } = camera;
  useEffect(() => {
    if (step === 'camera') void begin();
  }, [step, begin]);

  // Released on the way out, and only on the way out — separate from the effect above because
  // leaving the camera step for the checks must not stop the camera they measure through. Belt and
  // braces, since leaving reloads the page, but a camera left running because a component unmounted
  // is not a thing to leave to chance.
  useEffect(() => dispose, [dispose]);

  // The last step's live inference. Loads a model of its own — the self-test disposed its harness on
  // the way to the results — and only while that step is open.
  const reading = useAimPreview(camera.handle, settings, step === 'aim');

  // The `settings` prop changes underneath this as decisions are applied, but nothing here reads it
  // again after the run starts — the starting configuration is taken once, at the top.
  async function start() {
    setStep('running');

    const onEvent = (event: OnboardingEvent) => {
      if (event.kind === 'log') setLog(event.text);
      if (event.kind === 'stage') setStages((all) => [...all, event.outcome]);
    };

    // Decisions are written through as they are made rather than collected to the end, which is what
    // makes leaving half way through safe: whatever this device has already proved stays proved.
    const apply = (patch: Partial<ChosenSettings>) => onSettingsChange(saveSettings(patch));

    let harness: Awaited<ReturnType<typeof createOnboardingHarness>> | null = null;
    try {
      const handle = camera.handle;
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
      setStep('finished');
    }
  }

  return (
    <AppCard>
      <Stack gap="md">
        <Box component="header">
          <Title order={2} fz="lg" c="green.4">Setting up this camera</Title>
        {/* A counter, so somebody can see there is an end to this — and so the day a third step
            arrives it is a line to edit rather than a screen to rethink. */}
          <Text fz="xs" c="dimmed">{STEP_LABEL[step]}</Text>
        </Box>

      {step === 'name' && (
        <NameStep
          name={name}
          onRename={onRename}
          onContinue={() => {
            // Publish on the way out of the step rather than per keystroke, exactly as the scoring
            // screen's field publishes on blur: a name is not worth a message a character.
            onNameSettled();
            setStep('camera');
          }}
        />
      )}

      {/* From the camera step onward, and not before: the preview belongs to the whole screen rather
          than to the step that introduces it. It is the element the benchmark reads its frames out
          of, so unmounting it when the step changes would hand the harness a detached video half way
          through — and it is worth seeing during the run anyway, since that is the camera being
          measured. It stays off the naming step because there is nothing in it to see yet.

          **The box is always there and always square**, with the video laid inside it rather than
          sizing it. A `<video>` is sized by the stream in it, so it collapses to nothing while there
          is none — which threw everything below it up the screen when the camera opened, and again
          every time the model change re-opened it at 1280. Real cameras may return landscape; the
          square box's centred cover crop is exactly the square every vision consumer uses. */}
      {step !== 'name' && (
        <SquareCameraPreview
          videoRef={camera.videoRef}
          testId="onboarding-preview"
          background="dark.9"
          withBorder
          radius="var(--mantine-radius-md)"
        >
          {camera.phase !== 'ready' && (
            <Center pos="absolute" inset={0}>
              <Text fz="sm" c="gray.6">Camera preview</Text>
            </Center>
          )}
          {/* Over the video and inside the same square box, which is the whole reason the geometry
              needs no scaling — see `BoardOverlay`. */}
          {step === 'aim' && <BoardOverlay spider={reading?.spider ?? null} tips={reading?.tips ?? []} />}
        </SquareCameraPreview>
      )}

      {step === 'camera' && <CameraStep camera={camera} onContinue={() => void start()} />}

      {(step === 'running' || step === 'finished') && (
        <>
          {/* Which model row is in bold is read from the live settings rather than carried on the
              stage, because it is not knowable when a stage finishes: the 960 px row is the choice
              right up until the 1280 px one beats it, and then it is not. */}
          <Stack component="ol" gap={6} m={0} p={0} style={{ listStyle: 'none' }} data-testid="onboarding-stages">
            {stages.map((stage) => (
              <StageRow
                key={stage.stage}
                stage={stage}
                chosen={stage.stage === (settings.model === 's_1280' ? 'model1280' : 'model960')}
              />
            ))}
          </Stack>

          {/* Two lines' worth of fixed height, and clamped to two: most of these messages wrap on a
              phone, and a taller one used to run underneath the button below rather than move it.
              Fixed rather than automatic so the panel does not jump every time the message changes,
              and cleared once there is a verdict — "Checking the results…" sitting under "Ready"
              reads as a screen that has lost track of itself. */}
          <Text fz="sm" c="gray.4" h="2.5rem" lineClamp={2} data-testid="onboarding-log">
            {step === 'running' ? log : ''}
          </Text>

          {step === 'finished' && (
            <Text fz="sm" c={failure ? 'red.4' : 'green.4'} data-testid="onboarding-verdict">
              {failure ?? `Ready. Using the ${settings.model === 's_1280' ? '1280' : '960'} px model${describeOverrides(settings)}.`}
            </Text>
          )}

          {/* The one optional step, offered rather than imposed: the phone is already usable, and
              this is for somebody standing next to a board who wants to see it work. Not offered
              when the checks found nothing that works — there would be no configuration to show. */}
          {step === 'finished' && !failure && (
            <Button
              onClick={() => setStep('aim')}
              data-testid="onboarding-try-board"
              style={{ alignSelf: 'flex-start' }}
            >
              Test on a board
            </Button>
          )}
        </>
      )}

      {step === 'aim' && <AimStep reading={reading} camera={camera} />}

      {/* One button, on every step, that changes its word rather than coming and going.

          Leaving is available throughout — before the camera is allowed, *during* the run, and at
          the end. A phone with no camera, or whose owner will not grant one, cannot finish setup and
          must still be able to leave it; and somebody who would rather be scoring should not have to
          sit out half a minute of benchmark. Whatever has already been measured stays applied.

          It is one element because the run can finish while a finger is on the way down. Two buttons
          meant the one being reached for was removed mid-tap and the tap landed on nothing, which is
          also what made this flaky to test. */}
      <Button
        variant="default"
        onClick={onDone}
        data-testid="onboarding-leave"
        style={{ alignSelf: 'flex-start' }}
      >
        {step === 'finished' || step === 'aim' ? 'Done' : 'Skip'}
      </Button>
      </Stack>
    </AppCard>
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
      : 'green.4'
    : 'red.4';

  const headline = headlineOf(stage);
  const details = stage.paths ?? stage.matrix;

  return (
    <Box component="li" data-testid={`stage-${stage.stage}`}>
      <UnstyledButton
        type="button"
        onClick={() => setOpen(!open)}
        // Validation has nothing behind it: one line is the whole result.
        disabled={!details}
        aria-expanded={details ? open : undefined}
        w="100%"
      >
        <Group justify="space-between" gap="sm" align="baseline" wrap="nowrap">
          <Text fz="sm" fw={chosen ? 700 : 400} c={chosen ? 'gray.2' : 'gray.3'}>
            {details && <Text span c="gray.6">{open ? '▾ ' : '▸ '}</Text>}
            {STAGE_LABEL[stage.stage]}
          </Text>
          <Text fz="xs" ff="monospace" c={colour}>
            {headline ? textFor(headline) : stage.ok ? 'ok' : 'failed'}
          </Text>
        </Group>
      </UnstyledButton>

      <Collapse expanded={open} keepMounted={false}>
        {stage.paths && (
          <Text ml="md" mt={2} ff="monospace" fz="xs">
            <Timing label="cpu" result={stage.paths.cpu} selected={stage.paths.selected === 'cpu'} colour={colour} />
            <Text span c="gray.6"> | </Text>
            <Timing label="gpu" result={stage.paths.gpu} selected={stage.paths.selected === 'gpu'} colour={colour} />
          </Text>
        )}
        {stage.matrix && <Matrix cells={stage.matrix.cells} selected={stage.matrix.selected} colour={colour} />}
      </Collapse>
    </Box>
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
    <Table.Tr>
      <Table.Td c="dimmed">pre {pre}</Table.Td>
      {(['cpu', 'gpu'] as const).map((inf) => {
        const key = `${pre}-${inf}` as ComboKey;
        return (
          <Table.Td key={key} ta="right">
            <Timing result={cells[key]} selected={selected === key} colour={colour} />
          </Table.Td>
        );
      })}
    </Table.Tr>
  );

  return (
    <Table mt={2} fz="xs" ff="monospace" withRowBorders={false} data-testid="stage-matrix">
      <Table.Thead>
        <Table.Tr>
          <Table.Th />
          <Table.Th ta="right" c="dimmed">inf cpu</Table.Th>
          <Table.Th ta="right" c="dimmed">inf gpu</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {row('cpu')}
        {row('gpu')}
      </Table.Tbody>
    </Table>
  );
}

/**
 * One measured path — `10ms`, or `dnf` where it was tried and did not work.
 *
 * The chosen one is bold and carries the stage's colour; the rest stay muted, because they are
 * context rather than the answer. All of them are always shown: a stage that reported only its
 * winner is exactly what left somebody unable to tell a broken GPU from one that lost a fair race.
 */
function Timing({ label, result, selected, colour }: {
  label?: string;
  result: PathResult;
  selected: boolean;
  colour: string;
}) {
  return (
    <Text
      span
      fw={selected ? 700 : 400}
      c={selected ? colour : 'dimmed'}
      title={result.kind === 'dnf' ? 'did not finish — this path was tried and failed' : undefined}
    >
      {label ? `${label}: ` : ''}
      {textFor(result)}
    </Text>
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
