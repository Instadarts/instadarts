import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  AppShell,
  Box,
  Code,
  Container,
  Group,
  Indicator,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useVisionRuntime } from '../../hooks/useVisionRuntime';
import { useScorerPower } from '../../hooks/useScorerPower';
import type { PendingCommand, ScorerLinkStatus } from '../../hooks/useScorerLink';
import type { ScoringActivation } from '../../lib/scorerReconnect';
import type { PowerStage } from '../../lib/scorerPower';
import type { BoardTip } from '../../../shared/vision/types';
import type { MediaTier } from '../../../shared/media';
import type { StillSource } from '../../hooks/useStillResponder';
import type { VideoFrameSource } from '../../media/videoPublisher';
import type { Region } from '../../../shared/media';
import { loadSettings, saveSettings } from '../../lib/scorerStorage';
import { e2eNumber } from '../../lib/e2e';
import { CameraPanel } from './CameraPanel';
import { CalibrationView } from './CalibrationView';
import { OnboardingView } from './OnboardingView';
import { FullscreenButton } from '../../components/FullscreenButton';
import { Screensaver } from './Screensaver';
import { SettingsPanel } from './SettingsPanel';
import { LatencyMeter, type LatencySnapshot } from '../../lib/latencyMeter';
import { SettingsIcon } from '../../components/AppIcons';

interface ScorerPageProps {
  status: ScorerLinkStatus;
  /** A match is running that this device feeds. What its power management turns on. */
  scoring: boolean;
  /** Whether a fresh active state starts a new context or resumes the one lost with the socket. */
  activation: ScoringActivation | null;
  /** The owner's last instruction, numbered so a repeat is not mistaken for a re-render. */
  command: PendingCommand | null;
  /** This device has given up waiting; the socket should close and stay closed. */
  onStandbyChange: (standby: boolean) => void;
  name: string;
  onRename: (name: string) => void;
  /** The user has finished typing the name — publish it. */
  onNameSettled: () => void;
  onUnpair: () => void;
  onTips: (tips: BoardTip[], ms: number) => void;
  onCameraActive: (active: boolean, error?: string) => void;
  /**
   * Told when this phone changes how much of its view it will share. The answer itself lives in the
   * settings blob like every other; this exists because the mesh above acts on it, and narrowing it
   * should stop a stream somebody is watching right now rather than at the next reload.
   */
  onMediaChange: (tier: MediaTier) => void;
  /**
   * Filled in with whatever can currently take a picture, for the still responder that lives above.
   * The camera is here and the mesh is up there; this is how the two meet.
   */
  stillSource: React.MutableRefObject<StillSource | null>;
  /** The same introduction as `stillSource`, for the live feed's frames. */
  videoSource: React.MutableRefObject<VideoFrameSource | null>;
  /**
   * And for the director's commands.
   *
   * Held apart from `videoSource` because the two have different lifetimes: a region survives a
   * camera restart, since it describes the board rather than any camera.
   */
  directVideo: React.MutableRefObject<((region: Region | null, transitionMs: number, resetMs: number) => void) | null>;
  /**
   * Filled in with a callback the parent calls whenever a still request arrives, so the latency
   * meter can record the end of a measurement. Same pattern as stillSource / videoSource.
   */
  latencyMeterRef?: React.MutableRefObject<{ onStillRequest: () => void } | null>;
}

type View = 'scoring' | 'settings' | 'calibration' | 'onboarding';

/** The scoring screen: what this device is looking at, and what the match it feeds looks like. */
export function ScorerPage({
  status,
  scoring,
  activation,
  command,
  onStandbyChange,
  name,
  onRename,
  onNameSettled,
  onUnpair,
  onTips,
  onCameraActive,
  onMediaChange,
  stillSource,
  videoSource,
  directVideo,
  latencyMeterRef,
}: ScorerPageProps) {
  // ── latency meter (dev only) — must be before useVisionRuntime, because the
  //     wrapped onTips callback is passed to it. ─────────────────────────────
  const meter = useRef(new LatencyMeter());
  const [meterSnapshot, setMeterSnapshot] = useState<LatencySnapshot>({ min: null, max: null, avg: null, last: null, count: 0 });

  // Feed tips results into the meter, then forward to the real callback.
  const onTipsWithMeter = useCallback((tips: BoardTip[], ms: number) => {
    meter.current.onTipsReceived(tips.length > 0);
    setMeterSnapshot(meter.current.snapshot());
    onTips(tips, ms);
  }, [onTips]);

  const vision = useVisionRuntime({ onTips: onTipsWithMeter, onCameraActive });

  // Expose the still-request callback for the parent.
  // Deliberately NOT in an effect — the parent reads it during render (same as stillSource).
  if (latencyMeterRef) {
    latencyMeterRef.current = { onStillRequest: () => { meter.current.onStillRequested(); setMeterSnapshot(meter.current.snapshot()); } };
  }

  // Watch motion-dot transitions. React only fires when the string value changes,
  // so repeat 'pending' reports during the settling period are naturally ignored.
  // The motion detector extends its quiet timer internally — the meter should not
  // treat those as new throws.
  const prevDot = useRef(vision.motion.dot);
  useEffect(() => {
    const dot = vision.motion.dot;
    const prev = prevDot.current;
    prevDot.current = dot;

    const isPending = dot === 'pending' || dot === 'pendingLarge';
    if (!isPending) return;

    // idle → pending: first motion after quiet — start a measurement.
    if (prev === 'idle') {
      meter.current.onMotionDetected();
      setMeterSnapshot(meter.current.snapshot());
      return;
    }
    // triggered → pending: inference already fired for the previous throw,
    // and now a new one is starting before the still request arrived — abandon.
    if (prev === 'triggered') {
      meter.current.onMotionReDetected();
      setMeterSnapshot(meter.current.snapshot());
    }
    // pending/pendingLarge → pending/pendingLarge: repeat detection during
    // settling — the motion detector handles this internally, ignore.
  }, [vision.motion.dot]);

  // ── end latency meter ─────────────────────────────────────────

  // Assigned during render rather than in an effect: a still request can arrive before effects have
  // run, and the honest answer to one is the camera as it is now.
  stillSource.current = { capture: vision.captureStill, located: vision.located };
  videoSource.current = { grab: vision.grabVideoFrame, element: vision.videoElement };
  directVideo.current = vision.directVideo;
  const [settings, setSettings] = useState(() => loadSettings());
  // A phone that has never been set up opens on that rather than on a board it has no settings for.
  // Read once at mount: `didOnboard` only changes on the way out of that screen, and on that path
  // the page reloads anyway.
  const [view, setView] = useState<View>(() => (settings.didOnboard ? 'scoring' : 'onboarding'));

  // Setup runs a camera and a model of its own, so the runtime must not open either underneath it —
  // a second stream off one device, and a second claim on the model singleton it is loading and
  // unloading. Two things could: a match starting (through the power hook's activation) and a
  // `camera_on` from the owner. Both go through `startCamera`, so guarding it once covers both.
  // Constant for the life of the page — the only way out of onboarding reloads — so this does not
  // churn the power timers.
  const onboarding = view === 'onboarding';

  const startCamera = useCallback(() => {
    if (onboarding) return;
    void vision.startPreferred();
  }, [onboarding, vision.startPreferred]);
  const stopCamera = useCallback(() => { void vision.stop(); }, [vision.stop]);

  /**
   * Leave onboarding, however it went — finished, skipped, or abandoned mid-run.
   *
   * Always a reload, and not for tidiness. The self-test calls `unloadModel()` on its way out, which
   * leaves the vision runtime holding a runner that has been deleted; the next inference would use
   * it. Reloading rebuilds the runtime against whatever the self-test decided, which is also exactly
   * what has to happen for a new model or accelerator to take effect.
   */
  const leaveOnboarding = useCallback(() => {
    saveSettings({ didOnboard: true });
    window.location.reload();
  }, []);

  const power = useScorerPower({
    scoring,
    activation,
    cameraActive: vision.cameraActive,
    // Minutes are what a person sets; milliseconds are what the timers run on. The overrides exist
    // because no test can wait two minutes, let alone thirty, and do nothing in a shipped build.
    graceMs: e2eNumber('graceMs') ?? settings.cameraOffAfterMinutes * 60_000,
    standbyMs: e2eNumber('standbyMs') ?? settings.standbyAfterMinutes * 60_000,
    startCamera,
    stopCamera,
  });

  useEffect(() => { onStandbyChange(power.standby); }, [power.standby, onStandbyChange]);

  // The owner's instructions, keyed on the sequence rather than the command, so "off, on, off" is
  // three actions rather than two. A camera command counts as activity — one turned on from the
  // other room would otherwise switch itself off two minutes later regardless — while a power-off
  // is the opposite of activity and goes straight to the stage.
  const { noteActivity, powerOff } = power;
  const handledCommand = useRef(0);
  useEffect(() => {
    if (!command || command.seq === handledCommand.current) return;
    handledCommand.current = command.seq;
    switch (command.name) {
      case 'camera_on':
        noteActivity();
        startCamera();
        break;
      case 'camera_off':
        noteActivity();
        stopCamera();
        break;
      case 'power_off':
        powerOff();
        break;
    }
  }, [command, noteActivity, powerOff, startCamera, stopCamera]);

  return (
    <AppShell header={onboarding ? undefined : { height: 52 }} padding={0} className="app-main">
      {/* No top bar during setup. Every control on it belongs to a phone that is already working —
          a link status somebody has not finished establishing, a name for a device not yet set up,
          and a Settings button that would drop straight to scoring with a model the self-test has
          unloaded. Setup is one screen with one thing to do on it. */}
      {!onboarding && (
        <AppShell.Header bg="dark.8" withBorder>
          <Group h="100%" px="md" justify="space-between" gap="sm" wrap="nowrap">
            <StatusBadge status={status} scoring={scoring} stage={power.stage} />
            <Group gap="xs" wrap="nowrap" miw={0}>
              <TextInput
              type="text"
              value={name}
              onChange={(event) => onRename(event.currentTarget.value.slice(0, 20))}
              onBlur={onNameSettled}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
              placeholder="Name this device"
              variant="unstyled"
              w="8rem"
              size="sm"
              styles={{ input: { borderBottom: '1px solid var(--mantine-color-dark-5)', textAlign: 'right' } }}
              />
              <FullscreenButton />
              <ActionIcon
                variant="default"
                size="lg"
                title={view === 'scoring' ? 'Settings' : 'Done'}
                aria-label={view === 'scoring' ? 'Settings' : 'Done'}
              onClick={() => setView((v) => (v === 'scoring' ? 'settings' : 'scoring'))}
              >
                <SettingsIcon />
              </ActionIcon>
            </Group>
          </Group>
        </AppShell.Header>
      )}

      <AppShell.Main>
        <Container size={448} px="sm" py="md">
          <Stack gap="md">
            {!window.isSecureContext && <InsecureContextHint />}

            {/* The camera panel is never unmounted: the motion detector binds its controls once, and the
                vision runtime owns a camera stream and a compiled model that must survive a settings trip. */}
            <Box display={view === 'scoring' ? 'block' : 'none'}>
              <CameraPanel vision={vision} poweredDown={power.stage !== 'awake'} motionAnimations={settings.motionAnimations} />
            </Box>

            {view === 'settings' && (
              <SettingsPanel
                vision={vision}
                onCalibrate={() => setView('calibration')}
                settings={settings}
                onSettingsChange={setSettings}
                onUnpair={onUnpair}
                onMediaChange={onMediaChange}
              />
            )}

            {view === 'calibration' && <CalibrationView vision={vision} onClose={() => setView('settings')} />}

            {view === 'onboarding' && (
              <OnboardingView
                settings={settings}
                onSettingsChange={setSettings}
                name={name}
                onRename={onRename}
                onNameSettled={onNameSettled}
                onDone={leaveOnboarding}
              />
            )}
          </Stack>
        </Container>
      </AppShell.Main>

      <Screensaver enabled={settings.screensaver} suppressed={view !== 'scoring'} />

      {import.meta.env.DEV && <LatencyDisplay snapshot={meterSnapshot} />}
    </AppShell>
  );
}

/** Dev-only latency readout: min / max / avg / last / count. */
function LatencyDisplay({ snapshot }: { snapshot: LatencySnapshot }) {
  if (snapshot.count === 0) return null;
  return (
    <Box pos="fixed" bottom={0} left={0} right={0} style={{ zIndex: 50, pointerEvents: 'none', textAlign: 'center' }}>
      <Text component="span" display="inline-block" bg="rgba(0, 0, 0, 0.7)" c="green.4" fz="xs" ff="monospace" px="md" py={6} style={{ borderRadius: 'var(--mantine-radius-md) var(--mantine-radius-md) 0 0' }}>
      M2E |  Min: <Text component="span" c="white">{snapshot.min}ms</Text>
        {' | '}
        Max: <Text component="span" c="white">{snapshot.max}ms</Text>
        {' | '}
        Avg: <Text component="span" c="white">{snapshot.avg}ms</Text>
        {' | '}
        Last: <Text component="span" c="white">{snapshot.last}ms</Text>
        {' | '}
        N: <Text component="span" c="white">{snapshot.count}</Text>
      </Text>
    </Box>
  );
}

/**
 * getUserMedia needs a secure context, and a phone on the LAN reaches this over plain http. Saying
 * so beats a camera that silently refuses to open.
 */
function InsecureContextHint() {
  return (
    <Alert color="yellow" title="The camera needs a secure context.">
      Add <Code style={{ userSelect: 'text' }}>{window.location.origin}</Code> to{' '}
      <Code style={{ userSelect: 'text' }}>chrome://flags/#unsafely-treat-insecure-origin-as-secure</Code>,
      or serve this over https.
    </Alert>
  );
}

interface StatusBadgeProps {
  status: ScorerLinkStatus;
  scoring: boolean;
  stage: PowerStage;
}

function StatusBadge({ status, scoring, stage }: StatusBadgeProps) {
  const [label, color] = describe(status, scoring, stage);
  return (
    <Group gap={6} wrap="nowrap" role="status" aria-label={label} title={label}>
      <Text visibleFrom="sm" fz="sm" c={color} truncate data-testid="scorer-status">
        {label}
      </Text>
      <Indicator color={color} processing={status === 'connecting'} size={9} position="middle-center">
        <Box w={10} h={10} aria-hidden />
      </Indicator>
    </Group>
  );
}

/**
 * What this device is doing, in the order that matters to whoever is looking at it.
 *
 * Standby comes first because in standby the socket is deliberately shut, and every other status
 * would read that as a fault. `active` used to claim it was scoring for a player whenever a
 * frontend had merely claimed it, which was a lie for most of an evening.
 */
function describe(status: ScorerLinkStatus, scoring: boolean, stage: PowerStage): [string, string] {
  if (stage === 'standby') return ['Asleep — tap to wake', 'gray'];
  if (scoring) return ['Scoring for a player', 'green'];
  if (stage === 'camera-off') return ['Idle — camera off', 'gray'];

  switch (status) {
    case 'active':
      return ['Ready — no match running', 'blue'];
    case 'waiting':
      return ['Paired — not in use', 'blue'];
    case 'connecting':
      return ['Connecting…', 'yellow'];
    case 'full':
      return ['Server is full — try again shortly', 'yellow'];
    default:
      return ['Not paired', 'gray'];
  }
}
