import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerMessage } from '../../shared/protocol';
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
}

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
  const [status, setStatus] = useState<Record<string, { online: boolean; cameraActive: boolean }>>({});
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null);

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
        setPairingCode(null);
        send({
          type: 'activate_devices',
          devices: [{ deviceId: device.deviceId, tokenHash: device.tokenHash, grabbedAt: Date.now() }],
        });
        break;
      }
      case 'devices_state': {
        const next: Record<string, { online: boolean; cameraActive: boolean }> = {};
        for (const d of msg.devices) next[d.deviceId] = { online: d.online, cameraActive: d.cameraActive };
        setStatus(next);
        break;
      }
      case 'device_lost':
        // Another tab has it. Drop the grab so we stop asking on every reconnect.
        setGrabs(clearActiveGrab(msg.deviceId));
        break;
    }
  }, [send]);

  const requestPairingCode = useCallback(() => {
    send({ type: 'create_pairing_code' });
  }, [send]);

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

  const forget = useCallback((deviceId: string) => {
    send({ type: 'deactivate_device', deviceId });
    setPaired(forgetPairedDevice(deviceId));
    setGrabs(loadActiveGrabs());
  }, [send]);

  const rename = useCallback((deviceId: string, name: string) => {
    setPaired(renamePairedDevice(deviceId, name));
  }, []);

  const devices: DeviceView[] = paired.map((device) => ({
    ...device,
    active: grabs.some((g) => g.deviceId === device.deviceId),
    online: status[device.deviceId]?.online ?? false,
    cameraActive: status[device.deviceId]?.cameraActive ?? false,
  }));

  return {
    devices,
    pairingCode,
    handleMessage,
    requestPairingCode,
    cancelPairing: () => setPairingCode(null),
    grab,
    release,
    forget,
    rename,
  };
}
