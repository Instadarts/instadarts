import { useState } from 'react';
import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  Menu,
  NativeSelect,
  NumberInput,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import type { useVisionRuntime } from '../../hooks/useVisionRuntime';
import type { MediaTier } from '../../../shared/media';
import { resetSettings, saveSettings, type ScorerSettings } from '../../lib/scorerStorage';
import { GRACE_MINUTES, STANDBY_MINUTES, type MinuteBounds } from '../../lib/scorerPower';
import {
  applyAppZoom,
  APP_ZOOM_STEP,
  loadAppZoom,
  MAX_APP_ZOOM,
  MIN_APP_ZOOM,
  saveAppZoom,
} from '../../layout/appZoom';

type Vision = ReturnType<typeof useVisionRuntime>;

interface SettingsPanelProps {
  vision: Vision;
  onCalibrate: () => void;
  settings: ScorerSettings;
  onSettingsChange: (settings: ScorerSettings) => void;
  name: string;
  onRename: (name: string) => void;
  onNameSettled: () => void;
  onUnpair: () => void;
  /** Also told live, since narrowing this should stop a stream somebody is watching right now. */
  onMediaChange: (tier: MediaTier) => void;
}

const MODEL_LABELS: Record<string, string> = {
  s_960: '960 px — faster, lighter',
  s_1280: '1280 px — slower, more detail',
};

/**
 * Everything about this device that is mount-time setup rather than scoring: which model, how
 * confident a detection has to be, the zoom, the lens, and what the screen does when nobody is
 * looking. It sits in the header menu because the scoring screen should be the board, not a console.
 */
export function SettingsPanel({
  vision,
  onCalibrate,
  settings,
  onSettingsChange,
  name,
  onRename,
  onNameSettled,
  onUnpair,
  onMediaChange,
}: SettingsPanelProps) {
  const lensValue = vision.settings.lensByCamera[vision.cameraLabel] ?? 0;
  const [scorerZoom, setScorerZoom] = useState(() => loadAppZoom('scorer'));
  const update = (patch: Partial<ScorerSettings>) => onSettingsChange(saveSettings(patch));
  const updateCompute = (patch: Partial<Pick<ScorerSettings,
    'forceCpuMotion' | 'forceCpuPreprocessing' | 'forceCpuInference'>>) => {
    onSettingsChange(vision.setComputeOptions(patch));
  };
  const changeScorerZoom = (change: number) => {
    setScorerZoom((current) => {
      const next = saveAppZoom('scorer', current + change);
      applyAppZoom('scorer', next);
      return next;
    });
  };

  return (
    <Stack gap={0}>
      <Menu.Label>Layout</Menu.Label>
      <Box px="sm" py="xs">
        <Group justify="space-between" gap="md" wrap="nowrap">
          <Text fz="sm">Zoom</Text>
          <Group gap={6} wrap="nowrap">
            <ActionIcon
              variant="default"
              size="sm"
              aria-label="Increase zoom"
              title="Increase zoom"
              disabled={scorerZoom >= MAX_APP_ZOOM}
              onClick={() => changeScorerZoom(APP_ZOOM_STEP)}
            >
              +
            </ActionIcon>
            <Text fz="sm" fw={600} ta="center" w="3rem" ff="monospace">
              {scorerZoom}%
            </Text>
            <ActionIcon
              variant="default"
              size="sm"
              aria-label="Decrease zoom"
              title="Decrease zoom"
              disabled={scorerZoom <= MIN_APP_ZOOM}
              onClick={() => changeScorerZoom(-APP_ZOOM_STEP)}
            >
              −
            </ActionIcon>
          </Group>
        </Group>
      </Box>

      <Menu.Divider />
      <Menu.Label>Camera and AI</Menu.Label>
      <Box px="sm" py="xs">
        <Stack gap="md">
          <NativeSelect
            label="Detection model"
            value={vision.settings.model}
            onChange={(event) => void vision.setModel(event.currentTarget.value)}
            data={Object.entries(MODEL_LABELS).map(([value, label]) => ({ value, label }))}
          />

          {vision.cameraActive && !vision.zoomRange && (
            <Text fz="sm" c="dimmed">This camera does not expose a zoom control.</Text>
          )}

          <Group justify="space-between" gap="sm" wrap="nowrap">
            <Text fz="sm">
              Lens correction{' '}
              <Text span ff="monospace" c="gray.4">{lensValue > 0 ? `+${lensValue}` : lensValue}</Text>
            </Text>
            <Button variant="default" size="compact-sm" onClick={onCalibrate} disabled={!vision.cameraActive}>
              Calibrate lens
            </Button>
          </Group>

          <Switch
            label="Motion overlay"
            description="Highlights tiles the motion detector sees changing. Turn off on slower devices."
            checked={settings.motionAnimations}
            onChange={(event) => update({ motionAnimations: event.currentTarget.checked })}
          />

          <Divider />

          <Text fz="sm" c="dimmed">Override WebGPU paths independently on this device.</Text>
          <CpuToggle
            label="Motion detector"
            checked={settings.forceCpuMotion}
            onChange={(forceCpuMotion) => updateCompute({ forceCpuMotion })}
          />
          <CpuToggle
            label="Preprocessing"
            checked={settings.forceCpuPreprocessing}
            onChange={(forceCpuPreprocessing) => updateCompute({ forceCpuPreprocessing })}
          />
          <CpuToggle
            label="Inference"
            checked={settings.forceCpuInference}
            onChange={(forceCpuInference) => updateCompute({ forceCpuInference })}
          />
        </Stack>
      </Box>

      <Menu.Divider />
      <Menu.Label>Sharing and power</Menu.Label>
      <Box px="sm" py="xs">
        <Stack gap="md">
          <Switch
            label="Screensaver"
            description="Dims after 30s. Scoring carries on underneath."
            checked={settings.screensaver}
            onChange={(event) => update({ screensaver: event.currentTarget.checked })}
          />

          <NativeSelect
            label="Share this view"
            description="The most this device will send. Whether anyone watches is decided on the paired frontend."
            value={settings.media}
            onChange={(event) => {
              const media = event.currentTarget.value as MediaTier;
              update({ media });
              onMediaChange(media);
            }}
            data={[
              { value: 'disabled', label: 'Nothing — this camera is not shared' },
              { value: 'stills', label: 'Stills only' },
              { value: 'video', label: 'Live video' },
            ]}
          />

          <Minutes
            label="Camera off after"
            hint="Idle time outside a match. A match starting turns it back on."
            value={settings.cameraOffAfterMinutes}
            bounds={GRACE_MINUTES}
            onChange={(v) => update({ cameraOffAfterMinutes: v })}
          />

          <Minutes
            label="Sleep after"
            hint="Releases the screen and disconnects. Only a tap on this phone brings it back."
            value={settings.standbyAfterMinutes}
            bounds={STANDBY_MINUTES}
            onChange={(v) => update({ standbyAfterMinutes: v })}
          />
        </Stack>
      </Box>

      <Menu.Divider />
      <Menu.Label>Device</Menu.Label>
      <Box px="sm" py="xs">
        <Stack gap="md">
          <TextInput
            label="Device name"
            description="Shown to browsers paired with this scoring device."
            value={name}
            placeholder="Board camera"
            maxLength={20}
            onChange={(event) => onRename(event.currentTarget.value.slice(0, 20))}
            onBlur={onNameSettled}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          />

          <Divider />

          {/* Start over: `resetSettings` keeps the name, the screensaver, both timers and what this
              phone is willing to share, and puts back everything the self-test is about to work out
              for itself. Then a reload, which is what makes it safe — a fresh page rebuilds the
              vision runtime and opens on onboarding, rather than unpicking a loaded model and a
              running camera in place. Confirmed first, because it throws away a lens calibration
              somebody may have spent a while on. */}
          <ConfirmRow
            label="Set up again"
            hint="Run the setup checks again from the start."
            confirmHint="Re-measures this device. The lens calibration and the model choice are reset; the name and the timers are kept."
            action="Set up"
            onConfirm={() => {
              resetSettings();
              window.location.reload();
            }}
          />

          <Divider />

          {/* Letting go of the browser this device is paired to, so it can be paired to another one.
              There is no undo: the old browser is not told and cannot give the pairing back, so a
              mis-tap costs a trip to the other screen for a fresh code. Everything else on this
              panel survives it — the model, the thresholds and the lens describe this camera, not
              whoever it was scoring for. */}
          <ConfirmRow
            label="Pairing"
            hint="Un-pair this device."
            confirmHint="You will need a new pairing code."
            action="Unpair"
            danger
            onConfirm={onUnpair}
          />
        </Stack>
      </Box>

      {import.meta.env.PROD && (
        <>
          <Menu.Divider />
          <Menu.Label>Links</Menu.Label>
          <Menu.Item
            component="a"
            href="/THIRD-PARTY-NOTICES.txt"
            target="_blank"
            rel="noopener noreferrer"
          >
            Third-party notices
          </Menu.Item>
        </>
      )}
    </Stack>
  );
}

interface ConfirmRowProps {
  label: string;
  hint: string;
  /** Replaces the hint once the button has been pressed once: what is about to happen. */
  confirmHint: string;
  /** The word on the button, before and after. The same one twice, so the target does not move. */
  action: string;
  /** Red rather than green, for the one that cannot be undone from this device. */
  danger?: boolean;
  onConfirm: () => void;
}

/** A row at the foot of the panel whose button asks once more before it does anything. */
function ConfirmRow({ label, hint, confirmHint, action, danger, onConfirm }: ConfirmRowProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <Group justify="space-between" gap="md" align="center" wrap="nowrap">
      <Stack gap={2}>
        <Text fz="sm">{label}</Text>
        <Text fz="xs" c="dimmed">{confirming ? confirmHint : hint}</Text>
      </Stack>
      {confirming ? (
        <Group gap="xs" wrap="nowrap">
          <Button variant="default" size="compact-sm" onClick={() => setConfirming(false)}>Cancel</Button>
          <Button size="compact-sm" color={danger ? 'red' : 'green'} onClick={onConfirm}>
            {action}
          </Button>
        </Group>
      ) : (
        <Button variant="default" size="compact-sm" onClick={() => setConfirming(true)}>
          {action}
        </Button>
      )}
    </Group>
  );
}

function CpuToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <Switch
      label={label}
      description={checked ? 'Force CPU' : 'Try WebGPU first'}
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

interface MinutesProps {
  label: string;
  hint: string;
  value: number;
  bounds: MinuteBounds;
  onChange: (minutes: number) => void;
}

/**
 * One of the two power delays.
 *
 * A number rather than a slider: these are set once at a mount and then meant to be forgotten, and
 * the bounds carry a promise — the floor keeps a device from switching off mid-setup, and the
 * ceiling is what stops a phone on a charger running its camera all night.
 */
function Minutes({ label, hint, value, bounds, onChange }: MinutesProps) {
  return (
    <NumberInput
      label={label}
      description={hint}
      inputMode="numeric"
      min={bounds.min}
      max={bounds.max}
      value={value}
      aria-label={label}
      allowDecimal={false}
      clampBehavior="blur"
      suffix=" min"
      // Committed on blur, not per keystroke: clamping mid-typing turns "30" into "3" and then
      // into the floor before the second digit lands.
      onChange={(next) => onChange(Number(next))}
      onBlur={(event) => onChange(Math.min(Math.max(Math.round(Number(event.currentTarget.value)) || bounds.default, bounds.min), bounds.max))}
    />
  );
}
