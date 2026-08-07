import { useState } from 'react';
import type { useVisionRuntime } from '../../hooks/useVisionRuntime';
import { saveSettings } from '../../lib/scorerStorage';
import { Slider } from './Slider';

type Vision = ReturnType<typeof useVisionRuntime>;

interface SettingsPanelProps {
  vision: Vision;
  onCalibrate: () => void;
  onScreensaverChange: (enabled: boolean) => void;
  screensaver: boolean;
  onUnpair: () => void;
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
export function SettingsPanel({ vision, onCalibrate, onScreensaverChange, screensaver, onUnpair }: SettingsPanelProps) {
  const lensValue = vision.settings.lensByCamera[vision.cameraLabel] ?? 0;

  return (
    <div className="w-full max-w-md flex flex-col gap-2 p-4 bg-gray-900 rounded-lg">
      <label className="flex flex-col gap-1 text-sm">
        <span>Model</span>
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

      <Slider
        label="Board keypoint confidence"
        value={vision.settings.boardThreshold}
        min={0.3}
        max={0.95}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => vision.setThresholds({ board: v })}
      />

      <Slider
        label="Dart tip confidence"
        value={vision.settings.tipThreshold}
        min={0.3}
        max={0.95}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => vision.setThresholds({ tip: v })}
      />

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
          checked={screensaver}
          onChange={(e) => {
            saveSettings({ screensaver: e.target.checked });
            onScreensaverChange(e.target.checked);
          }}
          className="w-5 h-5"
        />
      </label>

      <Unpair onUnpair={onUnpair} />
    </div>
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
            ? 'The other browser keeps no way back. You will need a new code.'
            : 'Forget this browser to pair with another one.'}
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

