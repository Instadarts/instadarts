import { scoreFromBoardCoords } from '../shared/scoring';
import type { GameSettings, DartThrow } from '../shared/types';
import type { BoardTip } from '../shared/vision/types';

// ============================================================
// Player name
// ============================================================

const NAME_MIN = 1;
const NAME_MAX = 20;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(CONTROL_CHARS, '');
  if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) return null;
  return trimmed;
}

// ============================================================
// Game settings
// ============================================================

const VALID_MODES = new Set(['x01']);
const SCORE_MIN = 101;
const SCORE_MAX = 999;

export function validateSettings(raw: unknown): Partial<GameSettings> | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const input = raw as Record<string, unknown>;
  const cleaned: Partial<GameSettings> = {};

  // mode
  if ('mode' in input) {
    if (typeof input.mode === 'string' && VALID_MODES.has(input.mode)) {
      cleaned.mode = input.mode as GameSettings['mode'];
    }
  }

  // startScore
  if ('startScore' in input) {
    const s = Number(input.startScore);
    if (Number.isFinite(s) && s >= SCORE_MIN && s <= SCORE_MAX && Number.isInteger(s)) {
      cleaned.startScore = s;
    }
  }

  // doubleIn
  if ('doubleIn' in input) {
    cleaned.doubleIn = Boolean(input.doubleIn);
  }

  // doubleOut
  if ('doubleOut' in input) {
    cleaned.doubleOut = Boolean(input.doubleOut);
  }

  // Reject if no valid keys
  if (Object.keys(cleaned).length === 0) return null;
  return cleaned;
}

// ============================================================
// Dart throws & visits
// ============================================================

const MAX_DARTS_PER_VISIT = 3;
const BOARD_MIN = 0;
const BOARD_MAX = 1_000_000;

export function validateDartThrow(raw: unknown): DartThrow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;

  const x = Number(d.x);
  const y = Number(d.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < BOARD_MIN || x > BOARD_MAX || y < BOARD_MIN || y > BOARD_MAX) return null;

  // Recompute score from coordinates — ignore client-supplied score
  const score = scoreFromBoardCoords(x, y);

  return { x, y, score };
}

// ============================================================
// Scoring devices
// ============================================================

/** Model output is capped at 32 detections, eight of which are board keypoints. */
const MAX_TIPS = 24;

/**
 * One inference's worth of dart tips from a scoring device.
 *
 * A malformed report is dropped **whole** — never salvaged, and above all never degraded to an
 * empty array, because an empty array is the takeout signal. "This report was nonsense" and "the
 * darts came out" must never be confusable.
 */
export function validateTips(raw: unknown): BoardTip[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TIPS) return null;

  const tips: BoardTip[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const t = item as Record<string, unknown>;
    const x = Number(t.x);
    const y = Number(t.y);
    const confidence = Number(t.confidence);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(confidence)) return null;
    if (x < BOARD_MIN || x > BOARD_MAX || y < BOARD_MIN || y > BOARD_MAX) return null;
    if (confidence < 0 || confidence > 1) return null;
    tips.push({ x, y, confidence });
  }
  return tips;
}

/** The device list a frontend claims on connect. Anything malformed drops that entry, not the lot. */
export function validateDeviceClaims(raw: unknown): { deviceId: string; tokenHash: string; grabbedAt: number }[] {
  if (!Array.isArray(raw)) return [];
  const claims: { deviceId: string; tokenHash: string; grabbedAt: number }[] = [];
  for (const item of raw.slice(0, MAX_CLAIMS)) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    if (typeof c.deviceId !== 'string' || c.deviceId.length < 16 || c.deviceId.length > 64) continue;
    if (typeof c.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(c.tokenHash)) continue;
    const grabbedAt = Number(c.grabbedAt);
    if (!Number.isFinite(grabbedAt)) continue;
    claims.push({ deviceId: c.deviceId, tokenHash: c.tokenHash, grabbedAt });
  }
  return claims;
}

const MAX_CLAIMS = 8;

export function validateVisit(raw: unknown): { playerId: string; darts: DartThrow[]; bust: false } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;

  if (typeof v.playerId !== 'string' || v.playerId.length === 0) return null;

  if (!Array.isArray(v.darts)) return null;
  if (v.darts.length < 1 || v.darts.length > MAX_DARTS_PER_VISIT) return null;

  const darts: DartThrow[] = [];
  for (const d of v.darts) {
    const validated = validateDartThrow(d);
    if (!validated) return null;
    darts.push(validated);
  }

  return { playerId: v.playerId, darts, bust: false };
}
