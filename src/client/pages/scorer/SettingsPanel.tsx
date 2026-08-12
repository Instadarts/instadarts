import { useState } from 'react';
import type { useVisionRuntime } from '../../hooks/useVisionRuntime';
import type { MediaTier } from '../../../shared/media';
import { saveSettings, type ScorerSettings } from '../../lib/scorerStorage';
import { GRACE_MINUTES, STANDBY_MINUTES, type MinuteBounds } from '../../lib/scorerPower';
import { Slider } from './Slider';

type Vision = ReturnType<typeof useVisionRuntime>;

interface SettingsPanelProps {
  vision: Vision;
  onCalibrate: () => void;
  settings: ScorerSettings;
  onSettingsChange: (settings: ScorerSettings) => void;
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
 * looking. It sits behind a toggle because the scoring screen should be the board, not a console.
 */
export function SettingsPanel({ vision, onCalibrate, settings, onSettingsChange, onUnpair, onMediaChange }: SettingsPanelProps) {
  const lensValue = vision.settings.lensByCamera[vision.cameraLabel] ?? 0;
  const update = (patch: Partial<ScorerSettings>) => onSettingsChange(saveSettings(patch));
  const updateCompute = (patch: Partial<Pick<ScorerSettings,
    'forceCpuMotion' | 'forceCpuPreprocessing' | 'forceCpuInference'>>) => {
    onSettingsChange(vision.setComputeOptions(patch));
  };

  return (
    <div className="w-full max-w-md flex flex-col gap-2 p-4 bg-gray-900 rounded-lg">
      <label className="flex flex-col gap-1 text-sm">
        <span>Detection model</span>
        <select
          value={vision.settings.model}
          onChange={(e) => void vision.setModel(e.target.value)}
          className="px-3 py-2 bg-gray-950 border border-gray-700 rounded"
        >
          {Object.entries(MODEL_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </label>

      {vision.cameraActive && !vision.zoomRange && (
        <p className="text-sm text-gray-500">This camera does not expose a zoom control.</p>
      )}

      <div className="hidden">
        <Slider
          label="Board keypoint confidence"
          value={vision.settings.boardThreshold}
          min={0.3}
          max={0.95}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => vision.setThresholds({ board: v })}
        />
      </div>

      <div className="hidden">
        <Slider
          label="Dart tip confidence"
          value={vision.settings.tipThreshold}
          min={0.3}
          max={0.95}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => vision.setThresholds({ tip: v })}
        />
      </div>

      <div className="flex items-center justify-between text-sm">
        <span>
          Lens correction
          <span className="ml-2 font-mono text-gray-400">{lensValue > 0 ? `+${lensValue}` : lensValue}</span>
        </span>
        <button
          onClick={onCalibrate}
          disabled={!vision.cameraActive}
          className="px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded transition-colors"
        >
          Calibrate lens
        </button>
      </div>

      <label className="flex items-center justify-between text-sm">
        <span>
          Screensaver
          <span className="block text-xs text-gray-500">Dims after 30s. Scoring carries on underneath.</span>
        </span>
        <input
          type="checkbox"
          checked={settings.screensaver}
          onChange={(e) => update({ screensaver: e.target.checked })}
          className="w-5 h-5"
        />
      </label>

      <div className="py-2 border-y border-gray-800 flex flex-col gap-2">
        <span className="text-sm font-medium">
          CPU diagnostics
          <span className="block text-xs font-normal text-gray-500">Override WebGPU paths independently on this device.</span>
        </span>
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
      </div>

      <label className="flex items-center justify-between text-sm">
        <span>
          Motion overlay
          <span className="block text-xs text-gray-500">Highlights tiles the motion detector sees changing. Turn off on slower devices.</span>
        </span>
        <input
          type="checkbox"
          checked={settings.motionAnimations}
          onChange={(e) => update({ motionAnimations: e.target.checked })}
          className="w-5 h-5"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span>
          Share this view
          <span className="block text-xs text-gray-500">
            The most this device will send. Whether anyone actually watches is decided on the
            frontend that paired it.
          </span>
        </span>
        <select
          value={settings.media}
          onChange={(e) => {
            const media = e.target.value as MediaTier;
            update({ media });
            onMediaChange(media);
          }}
          className="px-3 py-2 bg-gray-950 border border-gray-700 rounded"
        >
          <option value="disabled">Nothing — this camera is not shared</option>
          <option value="stills">Stills only</option>
          <option value="video">Live video</option>
        </select>
      </label>

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

      <Unpair onUnpair={onUnpair} />
    </div>
  );
}

function CpuToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center justify-between text-sm">
      <span>{label}</span>
      <span className="flex items-center gap-2 text-xs text-gray-500">
        Force CPU
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="w-5 h-5"
        />
      </span>
    </label>
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
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>
        {label}
        <span className="block text-xs text-gray-500">{hint}</span>
      </span>
      <span className="flex items-center gap-1 shrink-0">
        <input
          type="number"
          inputMode="numeric"
          min={bounds.min}
          max={bounds.max}
          value={value}
          aria-label={label}
          // Committed on blur, not per keystroke: clamping mid-typing turns "30" into "3" and then
          // into the floor before the second digit lands.
          onChange={(e) => onChange(Number(e.target.value))}
          onBlur={(e) => onChange(Math.min(Math.max(Math.round(Number(e.target.value)) || bounds.default, bounds.min), bounds.max))}
          className="w-16 px-2 py-1 text-right bg-gray-950 border border-gray-700 rounded"
        />
        <span className="text-gray-500">min</span>
      </span>
    </label>
  );
}

/**
 * Letting go of the browser this device is paired to, so it can be paired to another one.
 *
 * Behind a confirmation because there is no undo: the old browser is not told and cannot give the
 * pairing back, so a mis-tap here costs a trip to the other screen for a fresh code. Everything
 * else on this panel survives it — the model, the thresholds and the lens describe this camera,
 * not whoever it was scoring for.
 */
function Unpair({ onUnpair }: { onUnpair: () => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="pt-3 border-t border-gray-800 flex items-center justify-between gap-3 text-sm">
      <span>
        Pairing
        <span className="block text-xs text-gray-500">
          {confirming
            ? 'You will need a new pairing code.'
            : 'Un-pair this device.'}
        </span>
      </span>
      {confirming ? (
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setConfirming(false)}
            className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onUnpair}
            className="px-3 py-1 bg-red-700 hover:bg-red-600 rounded transition-colors"
          >
            Unpair
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="px-3 py-1 shrink-0 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
        >
          Unpair
        </button>
      )}
    </div>
  );
}
