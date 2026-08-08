// Scoring device pairing, entirely in memory.
//
// Two states, deliberately separate:
//
//   · **paired** — a device belongs to a browser. Neither side of that lives here: the device keeps
//     {deviceId, token} in its own localStorage and the frontend keeps {deviceId, tokenHash} in
//     its own. This module only recognises them when they both turn up.
//   · **active** — a device is bound to exactly one frontend socket. That is the claim below.
//
// Because nothing is persisted, a server restart empties everything — and has to be survivable.
// It is, because neither secret was ever the server's to remember: on the next connection the
// device presents its token and the frontend presents its hash, and the pair is recognised again.
//
// The asymmetry between those two is load-bearing. **Only a device may create a registry entry**,
// because only a device holds the token; a frontend's tokenHash is matched against an entry and
// never used to seed one. Without that, anyone who had once seen a deviceId could squat it after a
// restart and lock the real device out for good.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';

// ============================================================
// Limits
// ============================================================

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars — these get read aloud
const CODE_LENGTH = 6;
const CODE_TTL_MS = 120_000;
/** Wrong codes a single connection may try before it is cut off. */
const MAX_PAIR_ATTEMPTS = 5;
/** Ceiling on remembered devices, so an unauthenticated flood cannot grow the map forever. */
const MAX_DEVICES = 500;

// ============================================================
// State
// ============================================================

interface DeviceRecord {
  id: string;
  /** sha256 of the device's token, hex. The token itself is never stored. */
  tokenHash: string;
  /** What the device calls itself. It tells us on every hello, since we forget it on restart. */
  name: string;
  /**
   * Whether a socket is currently open for it. The record outlives the socket while a frontend
   * still holds a claim, so that a phone that drops off the Wi-Fi comes back to the same pairing
   * rather than a new one — which is exactly why "we remember it" is not the same as "it is here".
   */
  connected: boolean;
  cameraActive: boolean;
}

interface Claim {
  tokenHash: string;
  /** The frontend connection that grabbed this device. */
  sessionId: string;
  /** Monotonic per browser, so a stale background tab cannot keep stealing from the foreground. */
  grabbedAt: number;
}

interface PendingCode {
  sessionId: string;
  expiresAt: number;
}

/** Devices that have proven who they are. Created only by a device presenting its token. */
const devices = new Map<string, DeviceRecord>();
/** Which frontend wants each device. Only effective once the device's own hash agrees. */
const claims = new Map<string, Claim>();
const codes = new Map<string, PendingCode>();
const pairAttempts = new Map<string, number>();

export type ClaimResult = 'ok' | 'mismatch' | 'stale';

export interface PairedDevice {
  deviceId: string;
  token: string;
  tokenHash: string;
  /** The frontend connection whose code was redeemed. */
  ownerSessionId: string;
}

// ============================================================
// Pairing codes
// ============================================================

/** Mint a short code for this frontend to show. Replaces any code it already had. */
export function createPairingCode(sessionId: string): { code: string; expiresAt: number } {
  clearPairingCodes(sessionId);

  let code = generateCode();
  while (codes.has(code)) code = generateCode();

  const expiresAt = Date.now() + CODE_TTL_MS;
  codes.set(code, { sessionId, expiresAt });
  return { code, expiresAt };
}

/**
 * Redeem a code. Single use: a successful redemption consumes it, so a code read aloud in a room
 * cannot pair a second phone.
 */
export function redeemPairingCode(raw: string, attemptKey: string): PairedDevice | null {
  if ((pairAttempts.get(attemptKey) ?? 0) >= MAX_PAIR_ATTEMPTS) return null;

  const code = normalizeCode(raw);
  const pending = code ? codes.get(code) : undefined;
  if (!pending || pending.expiresAt <= Date.now()) {
    pairAttempts.set(attemptKey, (pairAttempts.get(attemptKey) ?? 0) + 1);
    return null;
  }

  codes.delete(code!);
  pairAttempts.delete(attemptKey);

  const deviceId = randomBytes(16).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);

  evictIfFull();
  devices.set(deviceId, { id: deviceId, tokenHash, name: '', connected: true, cameraActive: false });

  return { deviceId, token, tokenHash, ownerSessionId: pending.sessionId };
}

export function clearPairingCodes(sessionId: string): void {
  for (const [code, pending] of codes) {
    if (pending.sessionId === sessionId) codes.delete(code);
  }
  pairAttempts.delete(sessionId);
}

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return code;
}

function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const char of code) {
    if (!CODE_CHARS.includes(char)) return null;
  }
  return code;
}

// ============================================================
// Device identity
// ============================================================

/**
 * A device proving who it is. This is the only way a registry entry comes into existence, which is
 * what makes the whole scheme survive a restart without anyone being able to squat a pairing:
 * recreating an entry requires the token, and naming a device at all requires its 128-bit id.
 */
export function verifyDevice(deviceId: unknown, token: unknown, name = ''): DeviceRecord | null {
  if (typeof deviceId !== 'string' || deviceId.length < 16 || deviceId.length > 64) return null;
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;

  const tokenHash = hashToken(token);
  const existing = devices.get(deviceId);
  if (existing) {
    if (!sameSecret(tokenHash, existing.tokenHash)) return null;
    existing.connected = true;
    if (name) existing.name = name;
    return existing;
  }

  evictIfFull();
  const record: DeviceRecord = { id: deviceId, tokenHash, name, connected: true, cameraActive: false };
  devices.set(deviceId, record);

  // A claim parked against this id before we knew the real hash was a squat if it disagrees.
  const claim = claims.get(deviceId);
  if (claim && !sameSecret(claim.tokenHash, tokenHash)) claims.delete(deviceId);

  return record;
}

export function setCameraActive(deviceId: string, active: boolean): void {
  const device = devices.get(deviceId);
  if (device) device.cameraActive = active;
}

export function setDeviceName(deviceId: string, name: string): void {
  const device = devices.get(deviceId);
  if (device) device.name = name;
}

/**
 * A device's socket closed. The record is kept while a frontend still holds it, so a phone that
 * loses Wi-Fi reconnects into the same pairing; with nobody holding it, there is nothing to keep.
 */
export function releaseDevice(deviceId: string): void {
  const device = devices.get(deviceId);
  if (!device) return;
  device.connected = false;
  device.cameraActive = false;
  if (!claims.has(deviceId)) devices.delete(deviceId);
}

// ============================================================
// Claims — which frontend a device is active for
// ============================================================

/**
 * A frontend grabbing a device.
 *
 * A wrong hash for a device we already know is rejected outright rather than arbitrated, so a
 * bogus claim can neither take a live pairing nor block the real one. Arbitration by `grabbedAt`
 * only ever runs between claims that agree about the token — which in practice means between tabs
 * of the same browser, which is the only case it exists for.
 */
export function claimDevice(
  deviceId: string,
  tokenHash: string,
  sessionId: string,
  grabbedAt: number,
): ClaimResult {
  const device = devices.get(deviceId);
  if (device && !sameSecret(tokenHash, device.tokenHash)) return 'mismatch';

  const incumbent = claims.get(deviceId);
  if (incumbent && incumbent.sessionId !== sessionId) {
    const incumbentIsReal = device !== undefined && sameSecret(incumbent.tokenHash, device.tokenHash);
    if (incumbentIsReal && incumbent.grabbedAt > grabbedAt) return 'stale';
  }

  claims.set(deviceId, { tokenHash, sessionId, grabbedAt });
  return 'ok';
}

/** Give a device up, if this session is the one holding it. */
export function unclaimDevice(deviceId: string, sessionId: string): boolean {
  const claim = claims.get(deviceId);
  if (!claim || claim.sessionId !== sessionId) return false;
  claims.delete(deviceId);
  forgetIfOrphaned(deviceId);
  return true;
}

/** Release every claim this frontend connection holds. Returns the devices it was holding. */
export function releaseSession(sessionId: string): string[] {
  const released: string[] = [];
  for (const [deviceId, claim] of claims) {
    if (claim.sessionId !== sessionId) continue;
    claims.delete(deviceId);
    released.push(deviceId);
  }
  for (const deviceId of released) forgetIfOrphaned(deviceId);
  clearPairingCodes(sessionId);
  return released;
}

/**
 * A record is only worth keeping while somebody is on one end of it. A device that has gone and is
 * no longer held has nothing left to remember — and it will recreate itself on its next hello.
 */
function forgetIfOrphaned(deviceId: string): void {
  const device = devices.get(deviceId);
  if (device && !device.connected && !claims.has(deviceId)) devices.delete(deviceId);
}

/**
 * The frontend session a device is active for — but only once the device has proven itself and the
 * two agree about the token. An unverified claim resolves to null, which is exactly what stops one
 * from doing anything.
 */
export function ownerOf(deviceId: string): string | null {
  const device = devices.get(deviceId);
  const claim = claims.get(deviceId);
  if (!device || !claim) return null;
  return sameSecret(claim.tokenHash, device.tokenHash) ? claim.sessionId : null;
}

/** Which devices this frontend currently has active, and how each is doing. */
export function devicesForSession(
  sessionId: string,
): { deviceId: string; name: string; cameraActive: boolean; online: boolean }[] {
  const owned: { deviceId: string; name: string; cameraActive: boolean; online: boolean }[] = [];
  for (const [deviceId, claim] of claims) {
    if (claim.sessionId !== sessionId) continue;
    const device = devices.get(deviceId);
    const paired = device !== undefined && sameSecret(claim.tokenHash, device.tokenHash);
    const online = paired && device!.connected;
    owned.push({
      deviceId,
      name: paired ? device!.name : '',
      cameraActive: online ? device!.cameraActive : false,
      online,
    });
  }
  return owned;
}

// ============================================================
// Helpers
// ============================================================

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of two hex digests. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function evictIfFull(): void {
  if (devices.size < MAX_DEVICES) return;
  // Drop something nobody is holding rather than refuse the honest device in front of us.
  for (const [deviceId] of devices) {
    if (!claims.has(deviceId)) {
      devices.delete(deviceId);
      return;
    }
  }
  const oldest = devices.keys().next().value;
  if (oldest) devices.delete(oldest);
}

/** Test seam: forget everything, as a restart would. */
export function resetDeviceRegistry(): void {
  devices.clear();
  claims.clear();
  codes.clear();
  pairAttempts.clear();
}
