// The last setup step's engine: the chosen configuration, run live on whatever the camera can see.
//
// **Not the vision runtime**, whose camera `ScorerPage` deliberately keeps shut for the whole of
// setup, and **not the self-test harness**, which has been disposed by the time this runs and which
// carries a motion detector and two decoded photographs this has no use for. What is left is small
// enough to own outright: load the model the self-test picked, run it a couple of times a second,
// and hand back what it saw.
//
// It runs the *chosen* configuration — the model, the accelerator and the preprocessing path the
// checks settled on — so this step demonstrates the thing this phone is actually going to do rather
// than some default. If the numbers upstairs were about whether it can, this is what it looks like.

import { useEffect, useState } from 'react';
import { loadModel, unloadModel } from '../vision/model';
import { MODELS } from '../vision/visionRuntime';
import { postprocess } from '../vision/postprocess';
import { computeDistortionCorrectedSpider, type SpiderProjection } from '../vision/lensGeometry';
import { sliderValueToLensK1 } from '../../shared/vision/lensDistortion';
import type { Keypoint, Point2D } from '../../shared/vision/types';
import { lensForCamera, type ScorerSettings } from '../lib/scorerStorage';
import type { OnboardingCamera } from './useOnboardingCamera';

/** Class 8 is a dart tip; 0–7 are the board's eight sector-boundary points. */
const TIP_CLASS = 8;

/**
 * Start-to-start, so a device slower than this runs its passes back to back rather than falling
 * behind a schedule it cannot keep. The same shape as the motion loop's 100 ms pacing.
 */
const PERIOD_MS = 500;

export interface AimReading {
  /** Board keypoints above threshold, 0–8. What the quality bar counts. */
  boardPoints: number;
  /** Where the board is, or null when too little of it is visible to place it. */
  spider: SpiderProjection | null;
  /** Dart tips above threshold, in normalized image space. */
  tips: Point2D[];
  /** What the last pass cost, end to end. */
  ms: number;
}

/**
 * Run the model on the live preview while `active`, and report what it sees.
 *
 * **Everything here is filtered at the pipeline's own thresholds**, so what the overlay draws is
 * exactly what would be scored. Drawing a board the scorer would refuse to use would be showing
 * somebody a working camera and then handing them one that does not work.
 */
export function useAimPreview(
  camera: OnboardingCamera | null,
  settings: ScorerSettings,
  active: boolean,
): AimReading | null {
  const [reading, setReading] = useState<AimReading | null>(null);

  // Named separately so the effect does not re-run on every unrelated settings change — a restart
  // means unloading and reloading a model underneath a live preview.
  const { model, boardThreshold, tipThreshold, forceCpuInference, forceCpuPreprocessing } = settings;

  useEffect(() => {
    if (!active || !camera) return;

    // Bumped on cleanup, and checked after every await: a pass already in flight when this step is
    // left must not deliver its result into a component that has moved on, or reschedule itself.
    let running = true;
    const lensK1 = sliderValueToLensK1(lensForCamera(settings, cameraLabelOf(camera)));

    (async () => {
      const entry = MODELS[model];
      await camera.ensureInputSize(entry.inputSize);
      const runner = await loadModel(entry.url, forceCpuInference ? 'wasm' : 'webgpu');
      if (!running) return;

      while (running) {
        const startedAt = performance.now();
        try {
          const { outputs } = await runner.run(camera.video, entry.inputSize, { forceCpuPreprocessing });
          if (!running) return;
          if (outputs.length >= 2) {
            setReading(read(postprocess(outputs[0], outputs[1], entry.inputSize)[0], {
              boardThreshold,
              tipThreshold,
              lensK1,
              ms: performance.now() - startedAt,
            }));
          }
        } catch {
          // One bad frame is not worth ending the step over — the next pass is 500 ms away, and the
          // reading simply stays as it was. A model that cannot run at all was caught by the checks.
        }
        if (!running) return;
        await sleep(Math.max(0, startedAt + PERIOD_MS - performance.now()));
      }
    })();

    return () => {
      running = false;
      void unloadModel();
    };
    // `settings` is read once, on the way in, for the lens value alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, camera, model, boardThreshold, tipThreshold, forceCpuInference, forceCpuPreprocessing]);

  return reading;
}

/** One pass's detections, split and placed. Pure, so the thresholding is testable without a GPU. */
export function read(
  keypoints: Keypoint[],
  options: { boardThreshold: number; tipThreshold: number; lensK1: number; ms: number },
): AimReading {
  const board = keypoints.filter((kp) => kp[3] !== TIP_CLASS && kp[2] >= options.boardThreshold);
  const tips = keypoints.filter((kp) => kp[3] === TIP_CLASS && kp[2] >= options.tipThreshold);
  const spider = computeDistortionCorrectedSpider(board, options.lensK1);
  return {
    boardPoints: board.length,
    spider: spider.canCompute ? spider : null,
    tips: tips.map((kp) => [kp[0], kp[1]] as Point2D),
    ms: options.ms,
  };
}

/** How well this is going, in the three states worth telling apart. */
export type AimQuality = 'none' | 'partial' | 'full';

/**
 * Red until the board can be placed at all, orange while it can, green only when every point is
 * there.
 *
 * Three states rather than a sliding colour: this is read while somebody is holding a phone at
 * arm's length, and a shade they have to interpret is not feedback. The red boundary is not a
 * number of its own — it is whatever `computeDistortionCorrectedSpider` could not work with, so the
 * bar and the overlay can never disagree about whether the board was found.
 */
export function qualityOf(reading: AimReading | null): AimQuality {
  if (!reading || !reading.spider) return 'none';
  return reading.boardPoints >= BOARD_POINTS ? 'full' : 'partial';
}

/** The board has eight of them, so eight is what a full bar means. */
export const BOARD_POINTS = 8;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The label this camera's lens correction is stored under.
 *
 * The video element's track carries it, which is the same label `camera.ts` saves the choice by —
 * so a calibration done on the scoring screen applies here without a second source of truth.
 */
function cameraLabelOf(camera: OnboardingCamera): string {
  const track = (camera.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
  return track?.label ?? '';
}
