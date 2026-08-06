// Vision pipeline constants, ported from dartszentrale-ai-scorer src/pipeline/constants.ts.
//
// These values are tuned against real boards and real phones. Re-expressing the board-space radii
// in instadarts units is the only change; do not re-tune them.

/** Minimum confidence required for a board keypoint (classes 0–7) to be used in homography. */
export const DEFAULT_BOARD_THRESHOLD = 0.8;

/** Minimum confidence required for a tip keypoint (class 8) to be projected. */
export const DEFAULT_TIP_THRESHOLD = 0.75;

/**
 * Keypoints within this distance are duplicates; only the highest-confidence one is kept before
 * projection. Normalized *image* space, which the port does not change.
 */
export const KEYPOINT_DEDUP_RADIUS = 0.003125;

/**
 * Radius of a typical steel tip (2.3mm diameter) in board units — the reference's 0.0025 of a
 * 451mm board. The two matching radii below are derived from it.
 */
const TIP_RADIUS = 2_500;

/**
 * Within a single throw window, tips from different cameras within this distance are merged into
 * one dart. Also the cross-camera "attach" radius: a tip from a camera that has not yet observed
 * an already-tracked dart, but lands within this distance of it, is that camera newly seeing the
 * known dart rather than a new dart. (Reference: 0.0125.)
 */
export const THROW_WINDOW_DART_RADIUS = TIP_RADIUS * 5;

/**
 * Across throw windows, a tip from a camera that already observed a tracked dart within this
 * distance of its stored observation is a re-sighting of that same dart and is dropped.
 * Deliberately below one tip diameter (2 × TIP_RADIUS), so two distinct physical tips can never
 * fall within it — a same-camera match here is provably the same dart. (Reference: 0.00375.)
 *
 * With a single camera this is the *only* mechanism preventing a dart already in the board from
 * being counted again on the next motion trigger.
 */
export const REPEAT_FILTER_RADIUS = TIP_RADIUS * 1.5;
