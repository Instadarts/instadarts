import { useState } from 'react';
import type { DeviceView, PairingCode } from '../hooks/useScoringDevices';
import { FullscreenButton } from './FullscreenButton';
import { PairDeviceDialog } from './PairDeviceDialog';

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
  const [open, setOpen] = useState(false);

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
              boardCamera={media ? boardCamera : null}
              showBoardChoice={media === true}
              onSelectBoardCamera={() => onBoardCameraChange(device.deviceId)}
              onGrab={() => onGrab(device.deviceId)}
              onRelease={() => onRelease(device.deviceId)}
              onForget={() => onForget(device.deviceId)}
              onSetCamera={(active) => onSetCamera(device.deviceId, active)}
              onPowerOff={() => onPowerOff(device.deviceId)}
            />
          ))}

          {pairing ? (
            <PairDeviceDialog code={pairingCode} onRequest={onRequestPairingCode} onCancel={onCancelPairing} />
          ) : (
            <button
              onClick={onStartPairing}
              disabled={!connected}
              className="self-start px-3 py-1 text-sm bg-green-700 hover:bg-green-600 disabled:bg-gray-800 rounded transition-colors"
            >
              Pair scoring device
            </button>
          )}

          {media !== null && (
            <div className="flex flex-col gap-2 border-t border-gray-800 pt-3">
              <label className="flex items-center gap-2 text-sm text-gray-400">
                <input
                  type="checkbox"
                  checked={media}
                  onChange={(e) => onMediaChange(e.target.checked)}
                  className="accent-green-600"
                />
                Share and watch live video during a match
              </label>
              {media && devices.some((d) => d.active && d.online) && (
                <label className="flex items-center gap-2 text-xs text-gray-400">
                  <input
                    type="radio"
                    name="board-camera"
                    aria-label="Board camera: none"
                    checked={boardCamera === null}
                    onChange={() => onBoardCameraChange(null)}
                    className="accent-green-600"
                  />
                  share no board video with opponents or spectators
                </label>
              )}
            </div>
          )}
        </div>
      )}
    </header>
  );
}

interface BoardCameraChoiceProps {
  device: DeviceView;
  selected: boolean;
  onSelect: () => void;
}

/**
 * The board-camera radio that lives in a device's own row.
 *
 * In the row rather than in a list of its own, so a device's name is written once and everything
 * about that device is in one place. The label is carried on `aria-label`: the row already says
 * which phone this is, and repeating the name would be noise on screen.
 *
 * A phone that has declined to share is shown disabled, with the reason, rather than quietly
 * omitted — otherwise its owner goes looking for a control that is not there.
 */
function BoardCameraChoice({ device, selected, onSelect }: BoardCameraChoiceProps) {
  const offered = device.media !== 'disabled';
  return (
    <label className={`flex items-center gap-2 text-xs ${offered ? 'text-gray-400' : 'text-gray-600'}`}>
      <input
        type="radio"
        name="board-camera"
        aria-label={`Board camera: ${device.name}`}
        checked={selected}
        disabled={!offered}
        onChange={onSelect}
        className="accent-green-600"
      />
      {!offered
        ? 'this device is not sharing its view'
        : device.media === 'stills'
          ? 'share this board in the match — stills only'
          : 'share this board with opponents and spectators'}
    </label>
  );
}

interface DeviceRowProps {
  device: DeviceView;
  /** The device currently shared as the board, so this row knows whether it is the one. */
  boardCamera: string | null;
  /** Hidden entirely when this browser has media switched off — there is nothing to choose. */
  showBoardChoice: boolean;
  onSelectBoardCamera: () => void;
  onGrab: () => void;
  onRelease: () => void;
  onForget: () => void;
  onSetCamera: (active: boolean) => void;
  onPowerOff: () => void;
}

function DeviceRow({ device, boardCamera, showBoardChoice, onSelectBoardCamera, onGrab, onRelease, onForget, onSetCamera, onPowerOff }: DeviceRowProps) {
  const [confirmingPowerOff, setConfirmingPowerOff] = useState(false);
  // Only a device this tab holds and can reach will hear anything.
  const reachable = device.active && device.online;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor(device)}`} />
          <span className="truncate">{device.name}</span>
          <span className="text-gray-500 shrink-0" data-testid="device-status">{statusLabel(device)}</span>
        </div>
        <div className="flex gap-2 shrink-0">
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
      </div>

      {/* The device's own words for why its camera is not on. Nothing here could have guessed them. */}
      {device.cameraError && <p className="text-xs text-yellow-500 pl-4">{device.cameraError}</p>}

      {showBoardChoice && reachable && (
        <div className="pl-4">
          <BoardCameraChoice
            device={device}
            selected={boardCamera === device.deviceId}
            onSelect={onSelectBoardCamera}
          />
        </div>
      )}

      {reachable && (
        <div className="flex items-center justify-between gap-3 pl-4 text-xs">
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
