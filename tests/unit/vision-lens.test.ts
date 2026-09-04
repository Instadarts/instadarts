import { describe, it, expect } from 'vitest';
import { computeDistortionCorrectedSpider, sliderValueToLensK1 } from '../../src/client/vision/lensGeometry';
import type { Keypoint } from '../../src/shared/vision/types';

/**
 * Projecting the board's spider back into the camera's picture.
 *
 * The property that matters is the round trip: place the eight board keypoints where an undistorted
 * camera would see them, and the projected spider must come back to the same places. A homography
 * solved with a transposed matrix, a sign flip, or a radial sampled from the wrong end still
 * produces a plausible-looking set of curves — so the assertions here are about *where* they land,
 * not that they exist.
 */

/** The eight board keypoints, as a perfect head-on camera would see them at a given scale. */
function headOnKeypoints(scale = 0.4): Keypoint[] {
  // Class order matches BOARD_KEYPOINT_NAMES: the eight sector boundaries the model is trained on.
  const names = ['18-4', '4-13', '10-15', '15-2', '7-16', '16-8', '14-9', '9-12'];
  const order = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  const angleOf = (n: number) => order.indexOf(n) * 18;

  return names.map((name, classId) => {
    const [left, right] = name.split('-').map(Number);
    const theta = ((0.5 * (angleOf(left) + angleOf(right))) * Math.PI) / 180;
    return [0.5 + scale * Math.sin(theta), 0.5 - scale * Math.cos(theta), 0.9, classId] as Keypoint;
  });
}

const distance = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('sliderValueToLensK1', () => {
  it('maps the slider ends to ±maxK1 and the middle to none', () => {
    expect(sliderValueToLensK1(0, 0.35)).toBe(0);
    expect(sliderValueToLensK1(100, 0.35)).toBeCloseTo(0.35);
    expect(sliderValueToLensK1(-100, 0.35)).toBeCloseTo(-0.35);
    expect(sliderValueToLensK1(50, 0.35)).toBeCloseTo(0.175);
  });

  it('clamps out-of-range and refuses nonsense', () => {
    expect(sliderValueToLensK1(500, 0.35)).toBeCloseTo(0.35);
    expect(sliderValueToLensK1(-500, 0.35)).toBeCloseTo(-0.35);
    expect(sliderValueToLensK1(Number.NaN, 0.35)).toBe(0);
  });
});

describe('computeDistortionCorrectedSpider', () => {
  it('says so rather than guessing when there are too few keypoints', () => {
    const result = computeDistortionCorrectedSpider(headOnKeypoints().slice(0, 3), 0);
    expect(result.canCompute).toBe(false);
    expect(result.reason).toBe('missing-keypoints');
    expect(result.rings).toEqual([]);
  });

  it('ignores dart tips: only the eight board classes locate the board', () => {
    const tips: Keypoint[] = [[0.1, 0.1, 0.99, 8], [0.2, 0.2, 0.99, 8]];
    const result = computeDistortionCorrectedSpider([...headOnKeypoints().slice(0, 3), ...tips], 0);
    expect(result.canCompute).toBe(false);
    expect(result.keypointCount).toBe(3);
  });

  it('projects the double ring back onto the keypoints it was given', () => {
    // With no lens distortion and a head-on view, the outermost ring must pass through all eight.
    const keypoints = headOnKeypoints(0.4);
    const result = computeDistortionCorrectedSpider(keypoints, 0);
    expect(result.canCompute).toBe(true);

    const doubleOuter = result.rings[0];
    for (const [x, y] of keypoints.map((k) => [k[0], k[1]] as [number, number])) {
      const nearest = Math.min(...doubleOuter.map((p) => distance(p, [x, y])));
      expect(nearest).toBeLessThan(0.01);
    }
  });

  it('keeps the rings concentric and ordered outwards', () => {
    // doubleOuter, doubleInner, tripleOuter, tripleInner, outerBull, innerBull — largest first.
    const result = computeDistortionCorrectedSpider(headOnKeypoints(0.4), 0);
    const radii = result.rings.map((ring) => {
      const mean = ring.reduce((sum, p) => sum + distance(p, [0.5, 0.5]), 0) / ring.length;
      return mean;
    });
    expect(radii).toHaveLength(6);
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeLessThan(radii[i - 1]);
    // The board's own proportions: the double ring sits at 170mm of a 225mm half-width.
    expect(radii[0] / 0.4).toBeCloseTo(1, 1);
  });

  it('draws one radial per sector boundary, each running outwards from the bull', () => {
    const result = computeDistortionCorrectedSpider(headOnKeypoints(0.4), 0);
    expect(result.radials).toHaveLength(20);
    for (const radial of result.radials) {
      const first = distance(radial[0], [0.5, 0.5]);
      const last = distance(radial[radial.length - 1], [0.5, 0.5]);
      expect(first).toBeLessThan(last);
    }
  });

  it('bows the spider outwards under positive k1, and pulls it in under negative', () => {
    // This is the whole point of the calibration slider: k1 must visibly move the drawn lines,
    // and in opposite directions, or sliding it tells the user nothing.
    const keypoints = headOnKeypoints(0.4);
    const ringRadius = (k1: number) => {
      const ring = computeDistortionCorrectedSpider(keypoints, k1).rings[0];
      return ring.reduce((sum, p) => sum + distance(p, [0.5, 0.5]), 0) / ring.length;
    };

    expect(ringRadius(0.3)).toBeGreaterThan(ringRadius(0));
    expect(ringRadius(-0.3)).toBeLessThan(ringRadius(0));
  });

  it('places a dart tip in the bed it landed in', () => {
    // A tip at the centre is the inner bull; one just outside the bull rings is a single.
    const keypoints = headOnKeypoints(0.4);
    const bull: Keypoint = [0.5, 0.5, 0.9, 8];
    const upper: Keypoint = [0.5, 0.5 - 0.2, 0.9, 8];

    const result = computeDistortionCorrectedSpider([...keypoints, bull, upper], 0);
    const placed = result.detections.filter((d) => d.classId === 8);
    expect(placed).toHaveLength(2);
    expect(placed[0].sectionId).toBe('inner-bull');
    // Straight up from the centre is the 20 bed.
    expect(placed[1].sectionId).toMatch(/-20$/);
  });
});
