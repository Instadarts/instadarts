// Vision pipeline constants.
//
// Every number here was tuned against real boards and real phones, and several of them are load
// bearing in ways no test will show you — see docs/vision.md for what only hardware can check.
// Treat them as measurements: change one and re-measure, do not adjust one to make a case pass.

/** Minimum confidence required for a board keypoint (classes 0–7) to be used in homography. */
export const DEFAULT_BOARD_THRESHOLD = 0.85;

/** Minimum confidence required for a tip keypoint (class 8) to be projected. */
export const DEFAULT_TIP_THRESHOLD = 0.8;

/**
 * Keypoints within this distance are duplicates; only the highest-confidence one is kept before
 * projection. Normalized *image* space.
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
 * known dart rather than a new dart.
 */
export const THROW_WINDOW_DART_RADIUS = TIP_RADIUS * 5;

/**
 * Across throw windows, a tip from a camera that already observed a tracked dart within this
 * distance of its stored observation is a re-sighting of that same dart and is dropped.
 * Deliberately below one tip diameter (2 × TIP_RADIUS), so two distinct physical tips can never
 * fall within it — a same-camera match here is provably the same dart.
 *
 * With a single camera this is the *only* mechanism preventing a dart already in the board from
 * being counted again on the next motion trigger.
 */
export const REPEAT_FILTER_RADIUS = TIP_RADIUS * 1.5;
