// The last step, and the only optional one: point it at a real board and watch it work.
//
// Everything before this proved the device can read *photographs*, which is what makes it a
// validation and also what stops it being the whole story. Nobody has yet pointed this phone at the
// board it will spend its evenings watching, and nothing has told them where to stand it. Those turn
// out to be the same problem: show the model working, live, while somebody moves the phone.
//
// **No scores.** Not shown, not computed. The question here is whether it can see the board, not
// what anybody hit.

import { useOnboardingCamera } from '../../hooks/useOnboardingCamera';
import { List, Progress, Stack, Text } from '@mantine/core';
import { BOARD_POINTS, qualityOf, type AimQuality, type AimReading } from '../../hooks/useAimPreview';
import { Slider } from './Slider';

interface AimStepProps {
  reading: AimReading | null;
  camera: ReturnType<typeof useOnboardingCamera>;
}

const QUALITY_BAR: Record<AimQuality, string> = {
  none: 'red',
  partial: 'orange',
  full: 'green',
};

const QUALITY_TEXT: Record<AimQuality, string> = {
  none: 'red.4',
  partial: 'orange.3',
  full: 'green.4',
};

export function AimStep({ reading, camera }: AimStepProps) {
  const quality = qualityOf(reading);
  const points = reading?.boardPoints ?? 0;

  return (
    <>
      <Stack gap={6} data-testid="aim-quality" data-points={points} data-quality={quality}>
        {/* A bar rather than a number, because it is read while holding a phone at arm's length and
            moving it: which way it is going matters more than what it says. */}
        <Progress value={(points / BOARD_POINTS) * 100} color={QUALITY_BAR[quality]} size="sm" radius="xl" />
        <Text fz="sm" c={QUALITY_TEXT[quality]}>
          {quality === 'none'
            ? 'Not enough of the board yet.'
            : quality === 'full'
              ? 'All 8 board points — this is what it wants.'
              : `${points} of ${BOARD_POINTS} board points.`}
        </Text>
      </Stack>

      {/* Where to stand it. The first two lines are requirements rather than preferences — a camera
          square-on to the board is the one view this reads badly — so they are written as what to do
          and not as what is allowed. The rest are without numbers on purpose: a tolerance invented to
          sound precise is worse than a sentence somebody can judge for themselves. */}
      <Text fz="sm" c="gray.4">It needs to see the board from an angle — across and from above or below.</Text>
      <List fz="sm" c="gray.4" spacing={4} pl="md">
        <List.Item>Off to one side, not straight in front of the board.</List.Item>
        <List.Item>Above or below the bull, not level with it.</List.Item>
        <List.Item>Out of the way of the throw.</List.Item>
        <List.Item>Somewhere a bounced dart cannot reach it.</List.Item>
        <List.Item>Zoom in until the top and bottom of the board touch the edges of the frame, rather more than less.</List.Item>
      </List>

      {/* Here as well as on the camera step, because one of those lines is about zoom and there is
          no way back. Absent where the platform does not expose it, as before. */}
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

      {/* No button of its own: the shell's one already says Done here, and a second way out beside
          it is a question nobody needs to answer. */}
    </>
  );
}
