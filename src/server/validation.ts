import { scoreFromBoardCoords } from '../shared/scoring';
import type { MatchSettings, ModeSettings, DartThrow } from '../shared/types';
import { describeMode } from '../shared/modes/catalog';
import type { SettingsField } from '../shared/modes/catalog';
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
// Match settings
// ============================================================

/**
 * Settings arriving from a client, validated against what the mode declares.
 *
 * Nothing here names an x01 setting: the fields, their bounds and their defaults all come from the
 * mode's descriptor, so a new mode is validated correctly the moment it is in the catalog.
 *
 * Returns a complete settings object — `current` supplies whatever the client did not send. Only a
 * malformed payload or an unknown mode is rejected outright; a value that fails its field's rules is
 * dropped and the current one kept, so one bad number cannot discard the rest of the form.
 */
export function validateSettings(raw: unknown, current: MatchSettings): MatchSettings | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  const mode = typeof input.mode === 'string' ? input.mode : current.mode;
  const descriptor = describeMode(mode);
  if (!descriptor) return null;

  // Switching mode starts from that mode's defaults: the outgoing mode's values mean nothing here.
  const cleaned: ModeSettings = mode === current.mode
    ? { ...current.modeSettings }
    : { ...descriptor.defaults };

  const incoming = typeof input.modeSettings === 'object' && input.modeSettings !== null
    ? (input.modeSettings as Record<string, unknown>)
    : {};

  // Only declared fields are ever read, which is also what makes __proto__ and friends a non-event.
  for (const field of descriptor.fields) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field.key)) continue;
    const value = validateField(field, incoming[field.key]);
    if (value !== undefined) cleaned[field.key] = value;
  }

  return { mode, modeSettings: cleaned };
}

function validateField(field: SettingsField, raw: unknown): string | number | boolean | undefined {
  if (field.kind === 'toggle') return Boolean(raw);

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return undefined;
  if (value < field.min || value > field.max) return undefined;
  return value;
}

// ============================================================
// Dart throws & visits
// ============================================================

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
