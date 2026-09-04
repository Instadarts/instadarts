// The gaming frontend's half of a scoring-device pairing.
//
// Two storage layers, because there are two different questions:
//
//   · **paired** — which devices belong to this browser. localStorage, so it survives everything.
//     The server does not remember this; re-presenting the hash on connect is what re-establishes
//     the pairing after a restart.
//   · **active** — which of them THIS TAB has grabbed. sessionStorage, so a reload re-grabs and a
//     second tab does not silently inherit a camera the user is watching in the first.
//
// The scoring app uses different keys entirely (lib/scorerStorage.ts), so both can run in one
// browser without either overwriting the other.

const PAIRED_KEY = 'instadarts_devices';
const ACTIVE_KEY = 'instadarts_active_devices';

/**
 * How many pairings this browser keeps, oldest dropped first.
 *
 * Deliberately the same as the server's `DEVICES_PER_USER` (src/server/capacity.ts), which is the
 * number of claims one session may hold. Remembering more than the server will honour would mean
 * quietly re-presenting pairings on every connect only for the server to evict them again — the
 * browser would show devices it can never actually use.
 */
const MAX_DEVICES = 5;

export interface PairedDevice {
  deviceId: string;
  /** sha256 of the device's token. We never hold the token itself. */
  tokenHash: string;
  name: string;
  pairedAt: number;
}

export interface ActiveGrab {
  deviceId: string;
  /** When this tab grabbed it. Newest grab wins, so a stale tab cannot steal it back. */
  grabbedAt: number;
}

export function loadPairedDevices(): PairedDevice[] {
  try {
    const raw = localStorage.getItem(PAIRED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isPairedDevice) : [];
  } catch {
    return [];
  }
}

export function savePairedDevice(device: PairedDevice): PairedDevice[] {
  const devices = [...loadPairedDevices().filter((d) => d.deviceId !== device.deviceId), device];
  return writePaired(devices.slice(-MAX_DEVICES));
}

export function renamePairedDevice(deviceId: string, name: string): PairedDevice[] {
  return writePaired(loadPairedDevices().map((d) => (d.deviceId === deviceId ? { ...d, name } : d)));
}

export function forgetPairedDevice(deviceId: string): PairedDevice[] {
  clearActiveGrab(deviceId);
  return writePaired(loadPairedDevices().filter((d) => d.deviceId !== deviceId));
}

export function loadActiveGrabs(): ActiveGrab[] {
  try {
    const raw = sessionStorage.getItem(ACTIVE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isActiveGrab) : [];
  } catch {
    return [];
  }
}

export function setActiveGrab(deviceId: string): ActiveGrab[] {
  const grabs = [...loadActiveGrabs().filter((g) => g.deviceId !== deviceId), { deviceId, grabbedAt: Date.now() }];
  return writeActive(grabs);
}

export function clearActiveGrab(deviceId: string): ActiveGrab[] {
  return writeActive(loadActiveGrabs().filter((g) => g.deviceId !== deviceId));
}

function writePaired(devices: PairedDevice[]): PairedDevice[] {
  try {
    localStorage.setItem(PAIRED_KEY, JSON.stringify(devices));
  } catch {
    // Private mode: the pairing lasts for this session and has to be redone next time.
  }
  return devices;
}

function writeActive(grabs: ActiveGrab[]): ActiveGrab[] {
  try {
    sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(grabs));
  } catch {
    // ignore
  }
  return grabs;
}

function isPairedDevice(value: unknown): value is PairedDevice {
  const d = value as PairedDevice;
  return !!d && typeof d.deviceId === 'string' && typeof d.tokenHash === 'string' && typeof d.name === 'string';
}

function isActiveGrab(value: unknown): value is ActiveGrab {
  const g = value as ActiveGrab;
  return !!g && typeof g.deviceId === 'string' && Number.isFinite(g.grabbedAt);
}
