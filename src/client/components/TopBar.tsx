import { useState } from 'react';
import type { DeviceView, PairingCode } from '../hooks/useScoringDevices';
import { PairDeviceDialog } from './PairDeviceDialog';

interface TopBarProps {
  connected: boolean;
  devices: DeviceView[];
  pairingCode: PairingCode | null;
  onRequestPairingCode: () => void;
  onCancelPairing: () => void;
  onGrab: (deviceId: string) => void;
  onRelease: (deviceId: string) => void;
  onForget: (deviceId: string) => void;
}

/**
 * The one part of the frontend that outlives the screen you are on. Pairing a camera and taking it
 * for this tab has nothing to do with whether you are at home, in a lobby or mid-match, so it lives
 * here rather than being duplicated into three pages.
 */
export function TopBar({
  connected,
  devices,
  pairingCode,
  onRequestPairingCode,
  onCancelPairing,
  onGrab,
  onRelease,
  onForget,
}: TopBarProps) {
  const [open, setOpen] = useState(false);
  const [pairing, setPairing] = useState(false);

  const scoring = devices.filter((d) => d.active && d.cameraActive).length;
  const summary = scoring > 0 ? `Cameras · ${scoring}` : 'Cameras';

  const closePairing = () => {
    setPairing(false);
    onCancelPairing();
  };

  return (
    <header className="sticky top-0 z-50 bg-gray-900 border-b border-gray-800">
      <div className="flex items-center justify-end gap-3 px-4 py-2">
        <span
          className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-yellow-500'}`}
          title={connected ? 'Connected' : 'Connecting…'}
        />
        <button
          onClick={() => setOpen((v) => !v)}
          className={`px-3 py-1 text-sm rounded transition-colors bg-gray-800 hover:bg-gray-700 ${
            scoring > 0 ? 'text-green-400' : 'text-gray-300'
          }`}
        >
          {summary}
        </button>
      </div>

      {open && (
        <div className="px-4 pb-3 flex flex-col gap-3 border-t border-gray-800 pt-3">
          {devices.length === 0 && !pairing && (
            <p className="text-sm text-gray-500">No scoring devices paired to this browser yet.</p>
          )}

          {devices.map((device) => (
            <DeviceRow
              key={device.deviceId}
              device={device}
              onGrab={() => onGrab(device.deviceId)}
              onRelease={() => onRelease(device.deviceId)}
              onForget={() => onForget(device.deviceId)}
            />
          ))}

          {pairing ? (
            <PairDeviceDialog code={pairingCode} onRequest={onRequestPairingCode} onCancel={closePairing} />
          ) : (
            <button
              onClick={() => setPairing(true)}
              disabled={!connected}
              className="self-start px-3 py-1 text-sm bg-green-700 hover:bg-green-600 disabled:bg-gray-800 rounded transition-colors"
            >
              Pair scoring device
            </button>
          )}
        </div>
      )}
    </header>
  );
}

interface DeviceRowProps {
  device: DeviceView;
  onGrab: () => void;
  onRelease: () => void;
  onForget: () => void;
}

function DeviceRow({ device, onGrab, onRelease, onForget }: DeviceRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor(device)}`} />
        <span className="truncate">{device.name}</span>
        <span className="text-gray-500 shrink-0">{statusLabel(device)}</span>
      </div>
      <div className="flex gap-2 shrink-0">
        {device.active ? (
          <button onClick={onRelease} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded transition-colors">
            Release
          </button>
        ) : (
          <button onClick={onGrab} className="px-2 py-1 bg-green-700 hover:bg-green-600 rounded transition-colors">
            Use here
          </button>
        )}
        <button onClick={onForget} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded transition-colors">
          Forget
        </button>
      </div>
    </div>
  );
}

function statusColor(device: DeviceView): string {
  if (!device.active) return 'bg-gray-600';
  if (device.cameraActive) return 'bg-green-500';
  if (device.online) return 'bg-blue-500';
  return 'bg-gray-600';
}

function statusLabel(device: DeviceView): string {
  if (!device.active) return 'not in use here';
  if (device.cameraActive) return 'camera on';
  if (device.online) return 'connected';
  return 'offline';
}
