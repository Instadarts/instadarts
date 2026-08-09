import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerMessage } from '../../shared/protocol';
import type { MediaTier } from '../../shared/media';
import {
  clearActiveGrab,
  forgetPairedDevice,
  loadActiveGrabs,
  loadPairedDevices,
  renamePairedDevice,
  savePairedDevice,
  setActiveGrab,
  type PairedDevice,
} from '../lib/deviceStorage';

export interface DeviceView extends PairedDevice {
  /** Grabbed by this tab. A device active in another tab is paired but not active here. */
  active: boolean;
  online: boolean;
  cameraActive: boolean;
  /** The device's own reason its camera is not on. Only it knows why one refused to open. */
  cameraError?: string;
  /**
   * How much of its view this device is willing to share, as the phone itself decided. Only a device
   * offering something may be nominated as the board camera — and this is the phone's answer, which
   * no frontend can overrule.
   */
  media: MediaTier;
  /** A camera request sent and not yet confirmed by the device. */
  cameraPending: boolean;
  /** Sent to standby from here. It went offline because we asked, not because it broke. */
  poweredOff: boolean;
}

/**
 * How long a camera request may go unanswered before it is called a failure.
 *
 * A phone has to be woken, list its cameras and open one, and it may be asked to do that over a
 * home Wi-Fi from another room. Long enough not to accuse a slow device; short enough that nobody
 * stands at the board watching a spinner.
 */
const CAMERA_REQUEST_TIMEOUT_MS = 8000;

export interface PairingCode {
  code: string;
  expiresAt: number;
}

/**
 * The frontend's scoring devices: which are paired to this browser, which this tab has grabbed,
 * and how each is doing.
 *
 * Grabs are re-sent on every (re)connect rather than once at startup. That is what re-establishes
 * a pairing after a server restart, and it is why the effect keys off `connected` rather than
 * running on mount: `send` before the socket is open would only be queued once.
 */
export function useScoringDevices(send: (msg: object) => void, connected: boolean) {
  const [paired, setPaired] = useState<PairedDevice[]>(() => loadPairedDevices());
  const [grabs, setGrabs] = useState(() => loadActiveGrabs());
  const [status, setStatus] = useState<Record<string, DeviceStatus>>({});
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null);
  /** Whether the pairing dialog is open. Owned here, because pairing a device is what ends it. */
  const [pairing, setPairing] = useState(false);
  /** Camera requests waiting on the device's own answer, by id — what it was asked for. */
  const [pending, setPending] = useState<Record<string, boolean>>({});
  /**
   * Devices this tab sent to standby.
   *
   * Held here because the server cannot tell the difference: a phone that was asked to sleep and one
   * whose battery died both leave the same closed socket behind. Per-tab and lost on a reload, at
   * which point the row honestly says "offline" again.
   */
  const [poweredOff, setPoweredOff] = useState<Record<string, boolean>>({});
  /** What each device's `online` was in the previous report, so a return can be told from a departure. */
  const wasOnline = useRef<Record<string, boolean>>({});

  // The activate effect must see the current lists without re-firing when they change for an
  // unrelated reason; only a new connection should re-send them.
  const claimsRef = useRef<{ paired: PairedDevice[]; grabs: ReturnType<typeof loadActiveGrabs> }>({ paired, grabs });
  claimsRef.current = { paired, grabs };

  const activate = useCallback(() => {
    const { paired: devices, grabs: active } = claimsRef.current;
    const claims = active
      .map((grab) => {
        const device = devices.find((d) => d.deviceId === grab.deviceId);
        return device ? { deviceId: device.deviceId, tokenHash: device.tokenHash, grabbedAt: grab.grabbedAt } : null;
      })
      .filter((c): c is { deviceId: string; tokenHash: string; grabbedAt: number } => c !== null);
    if (claims.length > 0) send({ type: 'activate_devices', devices: claims });
  }, [send]);

  useEffect(() => {
    if (connected) activate();
    else setStatus({});
  }, [connected, activate]);

  const handleMessage = useCallback((msg: ServerMessage): void => {
    switch (msg.type) {
      case 'pairing_code':
        setPairingCode({ code: msg.code, expiresAt: msg.expiresAt });
        break;
      case 'device_paired': {
        // Name it after its position in the list; the user renames it if they care.
        const existing = loadPairedDevices();
        const device: PairedDevice = {
          deviceId: msg.deviceId,
          tokenHash: msg.tokenHash,
          name: `Camera ${existing.length + 1}`,
          pairedAt: Date.now(),
        };
        setPaired(savePairedDevice(device));
        setGrabs(setActiveGrab(msg.deviceId));
        // A code is single-use, so pairing one device ends the exercise. Leaving the dialog open
        // meant it either sat on "Requesting a code…" or minted a second code nobody asked for.
        setPairingCode(null);
        setPairing(false);
        send({
          type: 'activate_devices',
          devices: [{ deviceId: device.deviceId, tokenHash: device.tokenHash, grabbedAt: Date.now() }],
        });
        break;
      }
      case 'devices_state': {
        const next: Record<string, DeviceStatus> = {};
        for (const d of msg.devices) {
          next[d.deviceId] = { online: d.online, cameraActive: d.cameraActive, cameraError: d.cameraError, media: d.media };
        }
        setStatus(next);

        // A device that is back is just back — otherwise the flag would outlive the sleep it
        // describes and mislabel the *next* time the phone went missing.
        //
        // Cleared on the way back in and never on the way out: a device sent to standby reports its
        // camera stopping while it is still connected, and treating that as "it's back" would erase
        // the flag a second before it was needed.
        setPoweredOff((current) => {
          const remaining = { ...current };
          let changed = false;
          for (const d of msg.devices) {
            if (d.online && wasOnline.current[d.deviceId] === false && remaining[d.deviceId]) {
              delete remaining[d.deviceId];
              changed = true;
            }
          }
          return changed ? remaining : current;
        });
        wasOnline.current = Object.fromEntries(msg.devices.map((d) => [d.deviceId, d.online]));

        // The device has spoken, so nothing is outstanding for it any more — whether it did what it
        // was asked or explained why it could not.
        setPending((current) => {
          const remaining = { ...current };
          let changed = false;
          for (const d of msg.devices) {
            if (!(d.deviceId in remaining)) continue;
            if (remaining[d.deviceId] === d.cameraActive || d.cameraError) {
              delete remaining[d.deviceId];
              changed = true;
            }
          }
          return changed ? remaining : current;
        });

        // A device names itself, and this is where that reaches the person who paired it. The
        // "Camera N" we assign at pairing is only a placeholder until it says otherwise.
        setPaired((current) => {
          let changed = false;
          let devices = current;
          for (const d of msg.devices) {
            const known = devices.find((p) => p.deviceId === d.deviceId);
            if (!d.name || !known || known.name === d.name) continue;
            devices = renamePairedDevice(d.deviceId, d.name);
            changed = true;
          }
          return changed ? devices : current;
        });
        break;
      }
      case 'device_lost':
        // Another tab has it. Drop the grab so we stop asking on every reconnect.
        setGrabs(clearActiveGrab(msg.deviceId));
        break;
    }
  }, [send]);

  /**
   * Open the pairing dialog and ask for a code.
   *
   * The request is made here rather than from the dialog's mount effect. Minting a code invalidates
   * the session's previous one, and an effect is not a promise that it runs once — StrictMode fires
   * it twice on purpose — so asking from an effect could put a dead code on screen.
   */
  const startPairing = useCallback(() => {
    setPairing(true);
    setPairingCode(null);
    send({ type: 'create_pairing_code' });
  }, [send]);

  /** The "New code" button: a fresh one, without leaving the dialog. */
  const requestPairingCode = useCallback(() => {
    setPairingCode(null);
    send({ type: 'create_pairing_code' });
  }, [send]);

  const cancelPairing = useCallback(() => {
    setPairing(false);
    setPairingCode(null);
  }, []);

  const grab = useCallback((deviceId: string) => {
    const grabbedAt = Date.now();
    setGrabs(setActiveGrab(deviceId));
    const device = claimsRef.current.paired.find((d) => d.deviceId === deviceId);
    if (device) send({ type: 'activate_devices', devices: [{ deviceId, tokenHash: device.tokenHash, grabbedAt }] });
  }, [send]);

  const release = useCallback((deviceId: string) => {
    setGrabs(clearActiveGrab(deviceId));
    send({ type: 'deactivate_device', deviceId });
  }, [send]);

  /**
   * Ask a device to start or stop its camera.
   *
   * Nothing is assumed to have happened. Stopping one always works, but starting one is the phone's
   * browser to refuse — a backgrounded tab, a permission never granted — so the row waits for the
   * device's own report rather than showing what was asked for.
   */
  const setCamera = useCallback((deviceId: string, active: boolean) => {
    setPending((current) => ({ ...current, [deviceId]: active }));
    setPoweredOff((current) => (current[deviceId] ? { ...current, [deviceId]: false } : current));
    send({ type: 'set_device_camera', deviceId, active });

    // A device that never answers is a device that did not do it. Cleared here rather than left to
    // spin, because the honest end of an unanswered request is an unanswered request.
    setTimeout(() => {
      setPending((current) => {
        if (!(deviceId in current)) return current;
        const remaining = { ...current };
        delete remaining[deviceId];
        return remaining;
      });
    }, CAMERA_REQUEST_TIMEOUT_MS);
  }, [send]);

  /** Send a device to standby. It will disconnect, and nothing here can bring it back. */
  const powerOff = useCallback((deviceId: string) => {
    setPoweredOff((current) => ({ ...current, [deviceId]: true }));
    setPending((current) => {
      if (!(deviceId in current)) return current;
      const remaining = { ...current };
      delete remaining[deviceId];
      return remaining;
    });
    send({ type: 'power_off_device', deviceId });
  }, [send]);

  const forget = useCallback((deviceId: string) => {
    send({ type: 'deactivate_device', deviceId });
    setPaired(forgetPairedDevice(deviceId));
    setGrabs(loadActiveGrabs());
  }, [send]);

  const rename = useCallback((deviceId: string, name: string) => {
    setPaired(renamePairedDevice(deviceId, name));
  }, []);

  const devices: DeviceView[] = paired.map((device) => {
    const live = status[device.deviceId];
    const online = live?.online ?? false;
    return {
      ...device,
      active: grabs.some((g) => g.deviceId === device.deviceId),
      online,
      cameraActive: live?.cameraActive ?? false,
      cameraError: live?.cameraError,
      media: live?.media ?? 'disabled',
      cameraPending: device.deviceId in pending,
      // Only worth saying while it is actually away; a device that came back on its own is just back.
      poweredOff: !online && (poweredOff[device.deviceId] ?? false),
    };
  });

  return {
    devices,
    pairing,
    pairingCode,
    handleMessage,
    startPairing,
    requestPairingCode,
    cancelPairing,
    grab,
    release,
    forget,
    rename,
    setCamera,
    powerOff,
  };
}

interface DeviceStatus {
  online: boolean;
  cameraActive: boolean;
  cameraError?: string;
  media: MediaTier;
}
