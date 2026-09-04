// What the last setup step makes of one inference.
//
// The loop around this needs a camera and a GPU and belongs to the e2e run; what is here is the part
// with opinions — which detections count, and what the bar therefore says. Both are decisions about
// honesty rather than about arithmetic: the overlay must not draw a board the scorer would refuse to
// use, and the bar must not be green about one.

import { describe, it, expect } from 'vitest';
import { read, qualityOf, BOARD_POINTS } from '../../src/client/hooks/useAimPreview';
import { DEFAULT_BOARD_THRESHOLD, DEFAULT_TIP_THRESHOLD } from '../../src/shared/vision/constants';
import type { Keypoint } from '../../src/shared/vision/types';

const OPTIONS = {
  boardThreshold: DEFAULT_BOARD_THRESHOLD,
  tipThreshold: DEFAULT_TIP_THRESHOLD,
  lensK1: 0,
  ms: 40,
};

/**
 * Board points where a square-on camera would see them — evenly spaced around a circle, each keeping
 * the class id it is named by.
 *
 * Named classes rather than a count, because *which* points were found matters: the geometry wants
 * at least three of the four opposing pairs `[0,1] [2,3] [4,5] [6,7]` represented, so four points
 * down one side is not the same as four points around the rim.
 */
function boardKeypoints(classIds: number[], score = 0.95): Keypoint[] {
  return classIds.map((classId) => {
    const angle = (classId / 8) * Math.PI * 2;
    return [0.5 + 0.4 * Math.cos(angle), 0.5 + 0.4 * Math.sin(angle), score, classId] as Keypoint;
  });
}

const ALL_EIGHT = [0, 1, 2, 3, 4, 5, 6, 7];

const tip = (x: number, y: number, score = 0.9): Keypoint => [x, y, score, 8];

describe('what one inference is worth', () => {
  it('counts the board points a full view gives, and places the board', () => {
    const reading = read(boardKeypoints(ALL_EIGHT), OPTIONS);
    expect(reading.boardPoints).toBe(BOARD_POINTS);
    expect(reading.spider?.rings.length).toBeGreaterThan(0);
    expect(reading.spider?.radials.length).toBeGreaterThan(0);
  });

  it('draws nothing when too little of the board is visible to place it', () => {
    // Not an error and not a failure — a phone being carried across a room looks like this, and the
    // honest answer is an empty preview rather than a spider guessed from two points.
    const reading = read(boardKeypoints([0, 1]), OPTIONS);
    expect(reading.spider).toBe(null);
    expect(reading.boardPoints).toBe(2);
  });

  it('ignores board points the scoring pipeline would ignore', () => {
    // The overlay is filtered exactly as `processPredictions` filters, so what is drawn is what
    // would be scored. Drawing a board built from 0.2-confidence points would be showing somebody a
    // working camera and then handing them one that does not work.
    const shaky = boardKeypoints(ALL_EIGHT, DEFAULT_BOARD_THRESHOLD - 0.01);
    expect(read(shaky, OPTIONS).boardPoints).toBe(0);
    expect(read(shaky, OPTIONS).spider).toBe(null);

    const firm = boardKeypoints(ALL_EIGHT, DEFAULT_BOARD_THRESHOLD);
    expect(read(firm, OPTIONS).boardPoints).toBe(BOARD_POINTS);
  });

  it('reports tips in image space, thresholded, and nothing about what they are worth', () => {
    const reading = read([...boardKeypoints(ALL_EIGHT), tip(0.5, 0.4), tip(0.6, 0.55, DEFAULT_TIP_THRESHOLD - 0.01)], OPTIONS);
    // The low-confidence one is dropped; the other keeps the coordinates it came in with.
    expect(reading.tips).toEqual([[0.5, 0.4]]);
    // Scores are a non-goal for this step, and there is nowhere here for one to leak out of.
    expect(Object.keys(reading)).toEqual(['boardPoints', 'spider', 'tips', 'ms']);
  });

  it('finds tips even where the board cannot be placed', () => {
    // Worth keeping separate: the dots say the model sees darts, the bar says it can locate them.
    // A camera close in on the treble twenty is exactly this, and saying "no board" while showing
    // the dart it found is the more useful pair of statements.
    const reading = read([...boardKeypoints([0, 1]), tip(0.5, 0.4)], OPTIONS);
    expect(reading.spider).toBe(null);
    expect(reading.tips).toHaveLength(1);
  });
});

describe('the quality bar', () => {
  it('is red until the board can be placed at all', () => {
    expect(qualityOf(null)).toBe('none');
    expect(qualityOf(read(boardKeypoints([]), OPTIONS))).toBe('none');
    expect(qualityOf(read(boardKeypoints([0, 2, 4]), OPTIONS))).toBe('none');
  });

  it('stays red on four points down one side of the board', () => {
    // Four is the arithmetic minimum for a homography and not the practical one: all four on one
    // side solves to something, and that something is nonsense. The geometry refuses unless three of
    // the four opposing pairs are represented, and the bar inherits the refusal rather than
    // repeating the rule — which is what stops the two from ever drifting apart.
    expect(qualityOf(read(boardKeypoints([0, 1, 2, 3]), OPTIONS))).toBe('none');
  });

  it('turns orange the moment the board can be placed', () => {
    // The boundary is not a number of its own — it is whatever the geometry could work with, which
    // is what keeps the bar and the overlay from ever disagreeing about whether a board was found.
    const reading = read(boardKeypoints([0, 2, 4, 6]), OPTIONS);
    expect(reading.spider).not.toBe(null);
    expect(qualityOf(reading)).toBe('partial');
    expect(qualityOf(read(boardKeypoints([0, 1, 2, 3, 4, 5, 6]), OPTIONS))).toBe('partial');
  });

  it('is green only when every point is there', () => {
    expect(qualityOf(read(boardKeypoints(ALL_EIGHT), OPTIONS))).toBe('full');
  });
});
