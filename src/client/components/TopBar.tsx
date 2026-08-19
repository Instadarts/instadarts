import { useState } from 'react';
import type { DeviceView, PairingCode } from '../hooks/useScoringDevices';
import { DropdownMenu } from './DropdownMenu';
import { FullscreenButton } from './FullscreenButton';
import { PairDeviceDialog } from './PairDeviceDialog';
import { Switch } from './Switch';

interface TopBarProps {
  connected: boolean;
  devices: DeviceView[];
  /** Whether the pairing dialog is open. Owned by useScoringDevices — pairing a device ends it. */
  pairing: boolean;
  pairingCode: PairingCode | null;
  onStartPairing: () => void;
  onRequestPairingCode: () => void;
  onCancelPairing: () => void;
  onGrab: (deviceId: string) => void;
  onRelease: (deviceId: string) => void;
  onForget: (deviceId: string) => void;
  onSetCamera: (deviceId: string, active: boolean) => void;
  onPowerOff: (deviceId: string) => void;
  /**
   * Whether this browser takes part in media, or null where the deployment does not carry it at
   * all. Null hides the switch entirely: offering somebody a choice their server will ignore is
   * worse than not mentioning it.
   */
  media: boolean | null;
  onMediaChange: (enabled: boolean) => void;
  /** The device shared as this player's board, or null for none. */
  boardCamera: string | null;
  onBoardCameraChange: (deviceId: string | null) => void;
}

/** Which menu is open, if any. At most one, and a second one is a second name here. */
type Menu = 'devices';

/**
 * The one part of the frontend that outlives the screen you are on. Pairing a camera and taking it
 * for this tab has nothing to do with whether you are at home, in a lobby or mid-match, so it lives
 * here rather than being duplicated into three pages.
 */
export function TopBar({
  connected,
  devices,
  pairing,
  pairingCode,
  onStartPairing,
  onRequestPairingCode,
  onCancelPairing,
  onGrab,
  onRelease,
  onForget,
  onSetCamera,
  onPowerOff,
  media,
  onMediaChange,
  boardCamera,
  onBoardCameraChange,
}: TopBarProps) {
  const [menu, setMenu] = useState<Menu | null>(null);

  const scoring = devices.filter((d) => d.active && d.online).length;
  const summary = scoring > 0 ? `Cameras · ${scoring}` : 'Cameras';

  return (
    <header className="sticky top-0 z-50 bg-gray-900 border-b border-gray-800">
      <div className="flex items-center justify-end gap-3 px-4 py-2">
        <span
          className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-yellow-500'}`}
          title={connected ? 'Connected' : 'Connecting…'}
        />
        <FullscreenButton />
        <DropdownMenu
          label={summary}
          open={menu === 'devices'}
          onOpenChange={(open) => setMenu(open ? 'devices' : null)}
          triggerClassName={scoring > 0 ? 'text-green-400' : 'text-gray-300'}
        >
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={onStartPairing}
              disabled={!connected || pairing}
              className="px-3 py-1 text-sm bg-green-700 hover:bg-green-600 disabled:bg-gray-800 disabled:text-gray-500 rounded transition-colors"
            >
              Pair scoring device
            </button>
            {media !== null && (
              // The full sentence is the accessible name; beside a button there is only room for
              // what it is, not for what it does.
              <label className="flex items-center gap-2 text-sm text-gray-400 shrink-0">
                Live video
                <Switch
                  checked={media}
                  onChange={onMediaChange}
                  label="Share and watch live video during a match"
                />
              </label>
            )}
          </div>

          {pairing && (
            <PairDeviceDialog code={pairingCode} onRequest={onRequestPairingCode} onCancel={onCancelPairing} />
          )}

          {devices.length === 0 && !pairing && (
            <p className="text-sm text-gray-500">No scoring devices paired to this browser yet.</p>
          )}

          {devices.map((device) => (
            <DeviceBox
              key={device.deviceId}
              device={device}
              // Off while this browser is out of media altogether: a switch reading on for a board
              // nobody can see would be a lie. The choice itself is remembered, and comes back when
              // the switch above does.
              boardCamera={media ? boardCamera : null}
              showBoardCamera={media !== null}
              onBoardCameraChange={(on) => onBoardCameraChange(on ? device.deviceId : null)}
              onGrab={() => onGrab(device.deviceId)}
              onRelease={() => onRelease(device.deviceId)}
              onForget={() => onForget(device.deviceId)}
              onSetCamera={(active) => onSetCamera(device.deviceId, active)}
              onPowerOff={() => onPowerOff(device.deviceId)}
            />
          ))}
        </DropdownMenu>
      </div>
    </header>
  );
}

interface DeviceBoxProps {
  device: DeviceView;
  /** The device currently shared as the board, so this box knows whether it is the one. */
  boardCamera: string | null;
  /** False where the deployment carries no media at all — there is nothing to nominate for. */
  showBoardCamera: boolean;
  onBoardCameraChange: (on: boolean) => void;
  onGrab: () => void;
  onRelease: () => void;
  onForget: () => void;
  onSetCamera: (active: boolean) => void;
  onPowerOff: () => void;
}

/** Everything about one paired device, in one box: what it is doing, and what can be done to it. */
function DeviceBox({ device, boardCamera, showBoardCamera, onBoardCameraChange, onGrab, onRelease, onForget, onSetCamera, onPowerOff }: DeviceBoxProps) {
  const [confirmingPowerOff, setConfirmingPowerOff] = useState(false);
  // Only a device this tab holds and can reach will hear anything.
  const reachable = device.active && device.online;
  // A phone that has declined to share is shown disabled, with the reason, rather than quietly
  // omitted — otherwise its owner goes looking for a control that is not there.
  const offered = device.media !== 'disabled';

  return (
    <div className="flex flex-col gap-2 rounded border border-gray-800 bg-gray-950/50 p-2">
      <div className="flex items-center gap-2 min-w-0 text-sm">
        <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor(device)}`} />
        <span className="truncate" data-testid="device-name">{device.name}</span>
        <span className="text-gray-500 shrink-0 ml-auto" data-testid="device-status">{statusLabel(device)}</span>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        {reachable && (
          <button
            onClick={() => onSetCamera(!device.cameraActive)}
            disabled={device.cameraPending}
            title={device.cameraActive ? 'Turn this camera off' : 'Turn this camera on'}
            className="px-2 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 rounded transition-colors"
          >
            {device.cameraPending ? '…' : device.cameraActive ? 'Camera off' : 'Camera on'}
          </button>
        )}
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

      {/* The device's own words for why its camera is not on. Nothing here could have guessed them. */}
      {device.cameraError && <p className="text-xs text-yellow-500">{device.cameraError}</p>}

      {showBoardCamera && reachable && (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between gap-3">
            <span className={`text-sm ${offered ? 'text-gray-400' : 'text-gray-600'}`}>Board camera</span>
            <Switch
              checked={boardCamera === device.deviceId}
              disabled={!offered}
              onChange={onBoardCameraChange}
              label={`Board camera: ${device.name}`}
            />
          </div>
          {!offered ? (
            <span className="text-xs text-gray-600">this device is not sharing its view</span>
          ) : device.media === 'stills' ? (
            <span className="text-xs text-gray-500">stills only</span>
          ) : null}
        </div>
      )}

      {reachable && (
        <div className="flex items-center justify-between gap-3 border-t border-gray-800/60 pt-1.5 text-xs">
          {confirmingPowerOff ? (
            <>
              <span className="text-gray-500">
                It will disconnect. You will have to walk over to wake it.
              </span>
              <span className="flex gap-2 shrink-0">
                <button
                  onClick={() => setConfirmingPowerOff(false)}
                  className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { setConfirmingPowerOff(false); onPowerOff(); }}
                  className="px-2 py-1 bg-red-700 hover:bg-red-600 rounded transition-colors"
                >
                  Power off
                </button>
              </span>
            </>
          ) : (
            <button
              onClick={() => setConfirmingPowerOff(true)}
              className="text-gray-500 hover:text-gray-300 transition-colors"
            >
              Power off
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function statusColor(device: DeviceView): string {
  if (!device.active) return 'bg-gray-600';
  if (device.cameraActive) return 'bg-green-500';
  if (device.online) return 'bg-blue-500';
  return 'bg-gray-600';
}

/**
 * A device that was sent to sleep looks exactly like one whose battery died — the server sees a
 * closed socket either way — so saying which happened is only possible here, where we know we asked.
 */
function statusLabel(device: DeviceView): string {
  if (device.poweredOff) return 'powered off';
  if (!device.active) return 'not in use here';
  if (device.cameraActive) return 'camera on';
  if (device.online) return 'connected';
  return 'offline';
}
