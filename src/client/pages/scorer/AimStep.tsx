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
import { BOARD_POINTS, qualityOf, type AimQuality, type AimReading } from '../../hooks/useAimPreview';
import { Slider } from './Slider';

interface AimStepProps {
  reading: AimReading | null;
  camera: ReturnType<typeof useOnboardingCamera>;
}

const QUALITY_BAR: Record<AimQuality, string> = {
  none: 'bg-red-500',
  partial: 'bg-orange-400',
  full: 'bg-green-500',
};

const QUALITY_TEXT: Record<AimQuality, string> = {
  none: 'text-red-400',
  partial: 'text-orange-300',
  full: 'text-green-400',
};

export function AimStep({ reading, camera }: AimStepProps) {
  const quality = qualityOf(reading);
  const points = reading?.boardPoints ?? 0;

  return (
    <>
      <div className="flex flex-col gap-1" data-testid="aim-quality" data-points={points} data-quality={quality}>
        {/* A bar rather than a number, because it is read while holding a phone at arm's length and
            moving it: which way it is going matters more than what it says. */}
        <div className="h-2 w-full rounded-full bg-gray-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${QUALITY_BAR[quality]}`}
            style={{ width: `${(points / BOARD_POINTS) * 100}%` }}
          />
        </div>
        <p className={`text-sm ${QUALITY_TEXT[quality]}`}>
          {quality === 'none'
            ? 'Not enough of the board yet.'
            : quality === 'full'
              ? 'All 8 board points — this is what it wants.'
              : `${points} of ${BOARD_POINTS} board points.`}
        </p>
      </div>

      {/* Where to stand it. Deliberately without numbers where there is no measurement to give: a
          tolerance invented to sound precise is worse than a sentence somebody can judge for
          themselves. */}
      <ul className="flex flex-col gap-1 text-sm text-gray-400 list-disc pl-5">
        <li>Off to either side is fine — it does not have to be straight in front of the board.</li>
        <li>Level with the bull, give or take a board's height.</li>
        <li>Out of the way of the throw.</li>
        <li>Somewhere a bounced dart cannot reach it.</li>
        <li>Zoom in until the top and bottom of the board just touch the edges of the frame.</li>
      </ul>

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
