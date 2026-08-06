// Ported verbatim from dartszentrale-ai-scorer src/vision/lens-geometry.js.
//
// Pure geometry, no DOM: given the detected board keypoints and a lens k1, it projects the board's
// spider (rings, radials, sector beds) back into IMAGE space. Overlaying that on the camera
// preview is what makes lens calibration possible — you slide k1 until the drawn spider sits on
// the real board's wires.
//
// The companion's own renderer  animates this with sweep delays and per-section
// highlighting; ours draws it plainly, because here it is a measuring tool rather than a flourish.
const BOARD_SECTOR_ORDER = Object.freeze([
  20, 1, 18, 4, 13,
  6, 10, 15, 2, 17,
  3, 19, 7, 16, 8,
  11, 14, 9, 12, 5,
]);
const BOARD_KEYPOINT_NAMES = Object.freeze(["18-4", "4-13", "10-15", "15-2", "7-16", "16-8", "14-9", "9-12"]);
const BOARD_KEYPOINT_PAIRS = Object.freeze([[0, 1], [2, 3], [4, 5], [6, 7]]);
const BOARD_CENTER = Object.freeze([0.5, 0.5]);
const MM_TO_BOARD_UNIT = 0.5 / 225.5;
const BOARD_RADII = Object.freeze({
  doubleOuter: 170.0 * MM_TO_BOARD_UNIT,
  doubleInner: 160.0 * MM_TO_BOARD_UNIT,
  tripleOuter: 107.0 * MM_TO_BOARD_UNIT,
  tripleInner: 97.0 * MM_TO_BOARD_UNIT,
  outerBull: (32.0 / 2.0) * MM_TO_BOARD_UNIT,
  innerBull: (13.0 / 2.0) * MM_TO_BOARD_UNIT,
});
const BOARD_REFERENCE_POINTS = buildBoardReferencePoints();
const RADIAL_SAMPLE_COUNT = 48;
const SECTION_ARC_SAMPLE_COUNT = 12;
const BOARD_SPIDER = buildBoardSpider();
const BOARD_SECTIONS = buildBoardSections();
const INVERSE_DISTORTION_ITERATIONS = 8;
const NORMALIZED_HALF_DIAGONAL = Math.SQRT1_2;

export function sliderValueToLensK1(value, maxK1) {
  const numericValue = Number(value);
  const clampedValue = Number.isFinite(numericValue) ? Math.min(Math.max(Math.round(numericValue), -100), 100) : 0;
  return (clampedValue / 100) * maxK1;
}

export function computeDistortionCorrectedSpider(detections, lensK1) {
  const keypoints = getBoardKeypoints(detections);
  const coverage = getBoardKeypointCoverage(keypoints);
  if (keypoints.length < 4 || coverage.coveredPairs < 3) {
    return {
      canCompute: false,
      reason: "missing-keypoints",
      keypointCount: keypoints.length,
      rings: [],
      radials: [],
      sections: [],
      detections: [],
    };
  }

  const source = [];
  const target = [];
  for (const keypoint of keypoints) {
    source.push(undistortNormalizedPoint([keypoint.x, keypoint.y], lensK1));
    target.push(BOARD_REFERENCE_POINTS[keypoint.classId]);
  }

  const imageToBoard = findHomography(source, target);
  const boardToUndistortedImage = invertHomography(imageToBoard);
  if (!boardToUndistortedImage) {
    return {
      canCompute: false,
      reason: "homography-failed",
      keypointCount: keypoints.length,
      rings: [],
      radials: [],
      sections: [],
      detections: [],
    };
  }

  return {
    canCompute: true,
    reason: "ok",
    keypointCount: keypoints.length,
    rings: BOARD_SPIDER.rings.map((ring) => projectBoardPath(ring, boardToUndistortedImage, lensK1)),
    radials: BOARD_SPIDER.radials.map((radial) => projectBoardPath(sampleRadial(radial), boardToUndistortedImage, lensK1)),
    sections: BOARD_SECTIONS.map((section) => ({
      ...section,
      points: projectBoardPath(section.points, boardToUndistortedImage, lensK1),
    })),
    detections: getBoardSpaceDetections(detections, imageToBoard, lensK1),
  };
}

function getBoardKeypoints(detections) {
  if (!Array.isArray(detections)) return [];
  return detections
    .filter((detection) => detection && detection[3] >= 0 && detection[3] <= 7)
    .map((detection) => ({
      classId: detection[3],
      x: Number(detection[0]),
      y: Number(detection[1]),
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function getBoardKeypointCoverage(keypoints) {
  const seen = new Set(keypoints.map((keypoint) => keypoint.classId));
  let coveredPairs = 0;
  for (const [left, right] of BOARD_KEYPOINT_PAIRS) {
    if (seen.has(left) || seen.has(right)) {
      coveredPairs += 1;
    }
  }
  return { coveredPairs };
}

function getBoardSpaceDetections(detections, imageToBoard, lensK1) {
  if (!Array.isArray(detections)) return [];
  const boardDetections = [];
  for (let index = 0; index < detections.length; index += 1) {
    const detection = detections[index];
    if (!detection) continue;
    const x = Number(detection[0]);
    const y = Number(detection[1]);
    const score = Number(detection[2]);
    const classId = Number(detection[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(score) || !Number.isFinite(classId)) {
      continue;
    }
    const boardPoint = transformHomographyPoint(undistortNormalizedPoint([x, y], lensK1), imageToBoard);
    if (!boardPoint) continue;
    const sectionId = getBoardSectionId(boardPoint);
    boardDetections.push({
      index,
      x,
      y,
      score,
      classId,
      boardX: boardPoint[0],
      boardY: boardPoint[1],
      sectionId,
    });
  }
  return boardDetections;
}

function getBoardSectionId(boardPoint) {
  const dx = boardPoint[0] - BOARD_CENTER[0];
  const dy = BOARD_CENTER[1] - boardPoint[1];
  const radius = Math.hypot(dx, dy);
  if (!Number.isFinite(radius)) return null;
  if (radius <= BOARD_RADII.innerBull) return "inner-bull";
  if (radius <= BOARD_RADII.outerBull) return "outer-bull";
  const sectorIndex = getBoardSectorIndex(dx, dy);
  if (sectorIndex === null || radius > BOARD_RADII.doubleOuter) return null;
  const number = BOARD_SECTOR_ORDER[sectorIndex];
  if (radius >= BOARD_RADII.doubleInner) return `double-${number}`;
  if (radius >= BOARD_RADII.tripleOuter) return `outer-single-${number}`;
  if (radius >= BOARD_RADII.tripleInner) return `triple-${number}`;
  return `inner-single-${number}`;
}

function getBoardSectorIndex(dx, dy) {
  const theta = Math.atan2(dx, dy);
  const normalizedDegrees = ((theta * 180 / Math.PI) + 360) % 360;
  return Math.round(normalizedDegrees / 18) % BOARD_SECTOR_ORDER.length;
}

function projectBoardPath(boardPoints, boardToUndistortedImage, lensK1) {
  const projectedPoints = [];
  for (const boardPoint of boardPoints) {
    const undistortedImagePoint = transformHomographyPoint(boardPoint, boardToUndistortedImage);
    if (!undistortedImagePoint) continue;
    projectedPoints.push(distortNormalizedPoint(undistortedImagePoint, lensK1));
  }
  return projectedPoints;
}

function distortNormalizedPoint(point, lensK1) {
  if (!Number.isFinite(lensK1) || Math.abs(lensK1) < 1e-12) {
    return point;
  }

  const dx = point[0] - 0.5;
  const dy = point[1] - 0.5;
  const r2 = ((dx * dx) + (dy * dy)) / (NORMALIZED_HALF_DIAGONAL * NORMALIZED_HALF_DIAGONAL);
  const scale = 1 + (lensK1 * r2);
  return [
    0.5 + (dx * scale),
    0.5 + (dy * scale),
  ];
}

function undistortNormalizedPoint(distortedPoint, lensK1) {
  if (!Number.isFinite(lensK1) || Math.abs(lensK1) < 1e-12) {
    return distortedPoint;
  }

  let undistortedPoint = [distortedPoint[0], distortedPoint[1]];
  for (let index = 0; index < INVERSE_DISTORTION_ITERATIONS; index += 1) {
    const redistortedPoint = distortNormalizedPoint(undistortedPoint, lensK1);
    undistortedPoint = [
      undistortedPoint[0] + (distortedPoint[0] - redistortedPoint[0]),
      undistortedPoint[1] + (distortedPoint[1] - redistortedPoint[1]),
    ];
  }
  return undistortedPoint;
}

function buildBoardReferencePoints() {
  const centerAngles = new Map(BOARD_SECTOR_ORDER.map((number, index) => [number, index * 18]));
  return BOARD_KEYPOINT_NAMES.map((name) => {
    const [left, right] = name.split("-").map((value) => Number(value));
    const thetaDeg = 0.5 * ((centerAngles.get(left) ?? 0) + (centerAngles.get(right) ?? 0));
    const theta = (thetaDeg * Math.PI) / 180;
    return [
      BOARD_CENTER[0] + (BOARD_RADII.doubleOuter * Math.sin(theta)),
      BOARD_CENTER[1] - (BOARD_RADII.doubleOuter * Math.cos(theta)),
    ];
  });
}

function buildBoardSpider() {
  const segments = 128;
  const rings = [
    BOARD_RADII.doubleOuter,
    BOARD_RADII.doubleInner,
    BOARD_RADII.tripleOuter,
    BOARD_RADII.tripleInner,
    BOARD_RADII.outerBull,
    BOARD_RADII.innerBull,
  ].map((radius) => {
    const points = [];
    for (let index = 0; index <= segments; index += 1) {
      const theta = (index / segments) * Math.PI * 2;
      points.push([
        BOARD_CENTER[0] + (radius * Math.sin(theta)),
        BOARD_CENTER[1] - (radius * Math.cos(theta)),
      ]);
    }
    return points;
  });

  const radials = [];
  for (let index = 0; index < 20; index += 1) {
    const theta = (((index * 18) - 9) * Math.PI) / 180;
    radials.push({
      inner: [
        BOARD_CENTER[0] + (BOARD_RADII.outerBull * Math.sin(theta)),
        BOARD_CENTER[1] - (BOARD_RADII.outerBull * Math.cos(theta)),
      ],
      outer: [
        BOARD_CENTER[0] + (BOARD_RADII.doubleOuter * Math.sin(theta)),
        BOARD_CENTER[1] - (BOARD_RADII.doubleOuter * Math.cos(theta)),
      ],
    });
  }
  return { rings, radials };
}

function buildBoardSections() {
  const sections = [];
  const beds = [
    ["double", BOARD_RADII.doubleInner, BOARD_RADII.doubleOuter],
    ["outer-single", BOARD_RADII.tripleOuter, BOARD_RADII.doubleInner],
    ["triple", BOARD_RADII.tripleInner, BOARD_RADII.tripleOuter],
    ["inner-single", BOARD_RADII.outerBull, BOARD_RADII.tripleInner],
  ];

  for (let sectorIndex = 0; sectorIndex < BOARD_SECTOR_ORDER.length; sectorIndex += 1) {
    const centerDeg = sectorIndex * 18;
    const startDeg = centerDeg - 9;
    const endDeg = centerDeg + 9;
    const number = BOARD_SECTOR_ORDER[sectorIndex];
    for (let bedIndex = 0; bedIndex < beds.length; bedIndex += 1) {
      const [bed, innerRadius, outerRadius] = beds[bedIndex];
      sections.push({
        id: `${bed}-${number}`,
        type: bed,
        number,
        sectorIndex,
        bedIndex,
        points: buildRingSectionPath(innerRadius, outerRadius, startDeg, endDeg),
      });
    }
  }

  sections.push({
    id: "outer-bull",
    type: "outer-bull",
    number: 25,
    sectorIndex: BOARD_SECTOR_ORDER.length,
    bedIndex: 0,
    points: buildDiskPath(BOARD_RADII.outerBull),
  });
  sections.push({
    id: "inner-bull",
    type: "inner-bull",
    number: 50,
    sectorIndex: BOARD_SECTOR_ORDER.length + 1,
    bedIndex: 0,
    points: buildDiskPath(BOARD_RADII.innerBull),
  });
  return sections;
}

function buildRingSectionPath(innerRadius, outerRadius, startDeg, endDeg) {
  const points = [];
  for (let index = 0; index <= SECTION_ARC_SAMPLE_COUNT; index += 1) {
    const theta = degreesToRadians(startDeg + (((endDeg - startDeg) * index) / SECTION_ARC_SAMPLE_COUNT));
    points.push(pointAtRadius(outerRadius, theta));
  }
  for (let index = SECTION_ARC_SAMPLE_COUNT; index >= 0; index -= 1) {
    const theta = degreesToRadians(startDeg + (((endDeg - startDeg) * index) / SECTION_ARC_SAMPLE_COUNT));
    points.push(pointAtRadius(innerRadius, theta));
  }
  return points;
}

function buildDiskPath(radius) {
  const points = [];
  const samples = SECTION_ARC_SAMPLE_COUNT * 8;
  for (let index = 0; index <= samples; index += 1) {
    points.push(pointAtRadius(radius, (index / samples) * Math.PI * 2));
  }
  return points;
}

function pointAtRadius(radius, theta) {
  return [
    BOARD_CENTER[0] + (radius * Math.sin(theta)),
    BOARD_CENTER[1] - (radius * Math.cos(theta)),
  ];
}

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function sampleRadial(radial) {
  const samples = [];
  for (let index = 0; index <= RADIAL_SAMPLE_COUNT; index += 1) {
    const t = index / RADIAL_SAMPLE_COUNT;
    samples.push([
      radial.inner[0] + ((radial.outer[0] - radial.inner[0]) * t),
      radial.inner[1] + ((radial.outer[1] - radial.inner[1]) * t),
    ]);
  }
  return samples;
}

function findHomography(sourcePoints, destinationPoints) {
  if (!Array.isArray(sourcePoints) || !Array.isArray(destinationPoints)) return null;
  if (sourcePoints.length !== destinationPoints.length || sourcePoints.length < 4) return null;

  const combinations = generateCombinations(sourcePoints.length, 4);
  const candidates = [];
  for (const indices of combinations) {
    const sourceSubset = indices.map((index) => sourcePoints[index]);
    const destinationSubset = indices.map((index) => destinationPoints[index]);
    const matrix = solveFourPointHomography(sourceSubset, destinationSubset);
    if (!matrix) continue;
    const evaluation = evaluateHomography(matrix, sourcePoints, destinationPoints);
    if (evaluation.inliers >= 4) {
      candidates.push({ matrix, ...evaluation });
    }
  }

  if (!candidates.length) {
    return sourcePoints.length === 4 ? solveFourPointHomography(sourcePoints, destinationPoints) : null;
  }

  return candidates.reduce((best, candidate) => {
    if (candidate.inliers > best.inliers) return candidate;
    if (candidate.inliers === best.inliers && candidate.meanError < best.meanError) return candidate;
    return best;
  }, candidates[0]).matrix;
}

function solveFourPointHomography(sourcePoints, destinationPoints) {
  const matrix = [];
  const vector = [];
  for (let index = 0; index < 4; index += 1) {
    const [x, y] = sourcePoints[index];
    const [u, v] = destinationPoints[index];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }
  const solution = gaussianElimination(matrix, vector);
  if (!solution) return null;
  return normalizeHomography([
    [solution[0], solution[1], solution[2]],
    [solution[3], solution[4], solution[5]],
    [solution[6], solution[7], 1],
  ]);
}

function transformHomographyPoint(point, matrix) {
  if (!matrix) return null;
  const [x, y] = point;
  const denominator = (matrix[2][0] * x) + (matrix[2][1] * y) + matrix[2][2];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) return null;
  const px = ((matrix[0][0] * x) + (matrix[0][1] * y) + matrix[0][2]) / denominator;
  const py = ((matrix[1][0] * x) + (matrix[1][1] * y) + matrix[1][2]) / denominator;
  return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : null;
}

function invertHomography(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 3) return null;
  const [[a, b, c], [d, e, f], [g, h, i]] = matrix;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const inverseDeterminant = 1 / determinant;
  return normalizeHomography([
    [(e * i - f * h) * inverseDeterminant, (c * h - b * i) * inverseDeterminant, (b * f - c * e) * inverseDeterminant],
    [(f * g - d * i) * inverseDeterminant, (a * i - c * g) * inverseDeterminant, (c * d - a * f) * inverseDeterminant],
    [(d * h - e * g) * inverseDeterminant, (b * g - a * h) * inverseDeterminant, (a * e - b * d) * inverseDeterminant],
  ]);
}

function evaluateHomography(matrix, sourcePoints, destinationPoints) {
  let inliers = 0;
  let totalError = 0;
  const threshold = 0.005;
  for (let index = 0; index < sourcePoints.length; index += 1) {
    const projected = transformHomographyPoint(sourcePoints[index], matrix);
    if (!projected) continue;
    const error = Math.hypot(projected[0] - destinationPoints[index][0], projected[1] - destinationPoints[index][1]);
    if (error <= threshold) {
      inliers += 1;
      totalError += error;
    }
  }
  return {
    inliers,
    meanError: inliers ? totalError / inliers : Infinity,
  };
}

function gaussianElimination(matrix, vector) {
  const size = matrix.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) {
        best = row;
      }
    }
    if (Math.abs(augmented[best][pivot]) < 1e-10) return null;
    if (best !== pivot) {
      [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
    }
    const pivotValue = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) {
      augmented[pivot][column] /= pivotValue;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function normalizeHomography(matrix) {
  const scale = matrix[2][2];
  if (!Number.isFinite(scale) || Math.abs(scale) < 1e-12) return matrix;
  return matrix.map((row) => row.map((value) => value / scale));
}

function generateCombinations(count, size) {
  const result = [];
  const current = [];
  function visit(start) {
    if (current.length === size) {
      result.push(current.slice());
      return;
    }
    for (let index = start; index < count; index += 1) {
      current.push(index);
      visit(index + 1);
      current.pop();
    }
  }
  visit(0);
  return result;
}
