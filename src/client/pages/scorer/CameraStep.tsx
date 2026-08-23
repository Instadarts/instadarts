// Step one of setting a phone up: which camera, and may we have it.
//
// Deliberately says nothing about where to point it. Aiming is done once the phone is on its mount
// with a board in front of it, and asking for it here would be asking somebody to hold a phone
// still through a benchmark. What this step settles is which lens the rest of setup measures.

import type { useOnboardingCamera } from '../../hooks/useOnboardingCamera';
import { Button, NativeSelect, Text } from '@mantine/core';
import { Slider } from './Slider';

interface CameraStepProps {
  camera: ReturnType<typeof useOnboardingCamera>;
  /** Forward, which also starts the checks — see `OnboardingView`. */
  onContinue: () => void;
}

export function CameraStep({ camera, onContinue }: CameraStepProps) {
  return (
    <>
      {camera.phase === 'checking' && <Text fz="sm" c="dimmed">Looking for a camera…</Text>}

      {camera.phase === 'ask' && (
        <>
          <Text fz="sm" c="gray.4">
            This device scores by watching the board, so it needs its camera. Your browser will ask
            you to allow it.
          </Text>
          <Button
            onClick={() => void camera.ask()}
            style={{ alignSelf: 'flex-start' }}
          >
            Allow camera
          </Button>
        </>
      )}

      {camera.phase === 'opening' && <Text fz="sm" c="dimmed">Starting the camera…</Text>}

      {camera.phase === 'failed' && (
        <>
          <Text fz="sm" c="red.4" data-testid="onboarding-camera-error">{camera.error}</Text>
          {/* Worth offering even after a refusal: the fix is in browser settings, and somebody who
              has just made it wants to come straight back here rather than start again. */}
          <Button
            variant="default"
            onClick={() => void camera.ask()}
            style={{ alignSelf: 'flex-start' }}
          >
            Try again
          </Button>
        </>
      )}

      {camera.phase === 'ready' && (
        <>
          {/* Only worth a control where there is a choice to make. A phone with one camera is not
              asked which one. */}
          {camera.cameras.length > 1 && (
            <NativeSelect
              label="Camera"
                value={camera.selected}
              onChange={(event) => void camera.choose(event.currentTarget.value)}
              data={camera.cameras.map((choice) => ({ value: choice.deviceId, label: choice.label }))}
            />
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

          <Text fz="sm" c="gray.4">
            Next, we measure the performance of this device, pick the right settings, and tell you if the device works. It takes about half a minute.
          </Text>
          <Button
            onClick={onContinue}
            data-testid="onboarding-start-checks"
            style={{ alignSelf: 'flex-start' }}
          >
            Start checks
          </Button>
        </>
      )}
    </>
  );
}
