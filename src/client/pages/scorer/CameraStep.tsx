// Step one of setting a phone up: which camera, and may we have it.
//
// Deliberately says nothing about where to point it. Aiming is done once the phone is on its mount
// with a board in front of it, and asking for it here would be asking somebody to hold a phone
// still through a benchmark. What this step settles is which lens the rest of setup measures.

import type { useOnboardingCamera } from '../../hooks/useOnboardingCamera';
import { Slider } from './Slider';

interface CameraStepProps {
  camera: ReturnType<typeof useOnboardingCamera>;
  /** Forward, which also starts the checks — see `OnboardingView`. */
  onContinue: () => void;
}

export function CameraStep({ camera, onContinue }: CameraStepProps) {
  return (
    <>
      {camera.phase === 'checking' && <p className="text-sm text-gray-500">Looking for a camera…</p>}

      {camera.phase === 'ask' && (
        <>
          <p className="text-sm text-gray-400">
            This device scores by watching the board, so it needs its camera. Your browser will ask
            you to allow it.
          </p>
          <button
            onClick={() => void camera.ask()}
            className="self-start px-4 py-2 bg-green-700 hover:bg-green-600 rounded font-semibold transition-colors"
          >
            Allow camera
          </button>
        </>
      )}

      {camera.phase === 'opening' && <p className="text-sm text-gray-500">Starting the camera…</p>}

      {camera.phase === 'failed' && (
        <>
          <p className="text-sm text-red-400" data-testid="onboarding-camera-error">{camera.error}</p>
          {/* Worth offering even after a refusal: the fix is in browser settings, and somebody who
              has just made it wants to come straight back here rather than start again. */}
          <button
            onClick={() => void camera.ask()}
            className="self-start px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
          >
            Try again
          </button>
        </>
      )}

      {camera.phase === 'ready' && (
        <>
          {/* Only worth a control where there is a choice to make. A phone with one camera is not
              asked which one. */}
          {camera.cameras.length > 1 && (
            <label className="flex flex-col gap-1 text-sm">
              <span>Camera</span>
              <select
                value={camera.selected}
                onChange={(e) => void camera.choose(e.target.value)}
                className="px-3 py-2 bg-gray-950 border border-gray-700 rounded"
              >
                {camera.cameras.map((choice) => (
                  <option key={choice.deviceId} value={choice.deviceId}>{choice.label}</option>
                ))}
              </select>
            </label>
          )}

          {/* Optional, and absent entirely where the platform does not expose zoom — iOS mostly
              does not. Nothing later depends on it having been touched. */}
          {camera.zoomRange && (
            <Slider
              label="Zoom"
              value={camera.zoom}
              min={camera.zoomRange.min}
              max={camera.zoomRange.max}
              step={camera.zoomRange.step}
              format={(v) => `${v.toFixed(1)}×`}
              onChange={(v) => void camera.applyZoom(v)}
            />
          )}

          <p className="text-sm text-gray-400">
            Next, we measure the performance of this device, pick the right settings, and tell you if the device works. It takes about half a minute.
          </p>
          <button
            onClick={onContinue}
            data-testid="onboarding-start-checks"
            className="self-start px-4 py-2 bg-green-700 hover:bg-green-600 rounded font-semibold transition-colors"
          >
            Start checks
          </button>
        </>
      )}
    </>
  );
}
