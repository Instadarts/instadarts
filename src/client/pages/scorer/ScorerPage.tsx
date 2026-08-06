import { useState } from 'react';
import { useVisionRuntime } from '../../hooks/useVisionRuntime';
import type { ScorerLinkStatus } from '../../hooks/useScorerLink';
import type { ScorerStateMessage } from '../../../shared/protocol';
import type { BoardTip } from '../../../shared/vision/types';
import { loadSettings } from '../../lib/scorerStorage';
import { CameraPanel } from './CameraPanel';
import { CalibrationView } from './CalibrationView';
import { Screensaver } from './Screensaver';
import { SettingsPanel } from './SettingsPanel';

interface ScorerPageProps {
  status: ScorerLinkStatus;
  state: ScorerStateMessage | null;
  name: string;
  onRename: (name: string) => void;
  /** The user has finished typing the name — publish it. */
  onNameSettled: () => void;
  onTips: (tips: BoardTip[], ms: number) => void;
  onCameraActive: (active: boolean) => void;
}

type View = 'scoring' | 'settings' | 'calibration';

/** The scoring screen: what this device is looking at, and what the match it feeds looks like. */
export function ScorerPage({ status, state, name, onRename, onNameSettled, onTips, onCameraActive }: ScorerPageProps) {
  const vision = useVisionRuntime({ onTips, onCameraActive });
  const [view, setView] = useState<View>('scoring');
  const [screensaver, setScreensaver] = useState(() => loadSettings().screensaver);

  return (
    <div className="flex-1 flex flex-col items-center p-4 gap-4">
      <div className="w-full max-w-md flex items-center justify-between gap-2">
        <StatusBadge status={status} />
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => onRename(e.target.value.slice(0, 20))}
            onBlur={onNameSettled}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            placeholder="Name this device"
            className="w-32 px-2 py-1 text-sm text-right bg-transparent border-b border-gray-800 focus:border-green-500 focus:outline-none"
          />
          <button
            onClick={() => setView((v) => (v === 'scoring' ? 'settings' : 'scoring'))}
            className="px-3 py-1 text-sm bg-gray-800 hover:bg-gray-700 rounded transition-colors"
          >
            {view === 'scoring' ? 'Settings' : 'Done'}
          </button>
        </div>
      </div>

      {!window.isSecureContext && <InsecureContextHint />}

      {/* The camera panel is never unmounted: the motion detector binds its controls once, and the
          vision runtime owns a camera stream and a compiled model that must survive a settings trip. */}
      <div className={view === 'scoring' ? 'contents' : 'hidden'}>
        <CameraPanel vision={vision} />
        <Scoreboard state={state} />
      </div>

      {view === 'settings' && (
        <SettingsPanel
          vision={vision}
          onCalibrate={() => setView('calibration')}
          screensaver={screensaver}
          onScreensaverChange={setScreensaver}
        />
      )}

      {view === 'calibration' && <CalibrationView vision={vision} onClose={() => setView('settings')} />}

      <Screensaver enabled={screensaver} suppressed={view !== 'scoring'} state={state} />
    </div>
  );
}

function Scoreboard({ state }: { state: ScorerStateMessage | null }) {
  if (!state?.match) {
    return <p className="text-gray-500">No match in progress.</p>;
  }
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex gap-4">
        {state.match.players.map((player) => (
          <div
            key={player.name}
            className={`text-center px-5 py-3 rounded-lg ${
              player.active ? 'bg-green-900 border border-green-500' : 'bg-gray-900'
            }`}
          >
            <p className="text-sm text-gray-400">{player.name}</p>
            <p className={`text-4xl font-bold font-mono ${player.active ? 'text-green-400' : 'text-gray-300'}`}>
              {player.remaining}
            </p>
          </div>
        ))}
      </div>
      <p className="font-mono text-xl text-gray-300 h-7" data-testid="scorer-visit">
        {state.match.visit.join('  ')}
      </p>
    </div>
  );
}

/**
 * getUserMedia needs a secure context, and a phone on the LAN reaches this over plain http. Saying
 * so beats a camera that silently refuses to open.
 */
function InsecureContextHint() {
  return (
    <div className="w-full max-w-md p-3 text-sm bg-yellow-950 border border-yellow-800 rounded">
      <p className="text-yellow-300 font-semibold">The camera needs a secure context.</p>
      <p className="text-yellow-200/80 mt-1">
        Add <span className="font-mono select-text">{window.location.origin}</span> to
        <span className="font-mono select-text"> chrome://flags/#unsafely-treat-insecure-origin-as-secure</span>,
        or serve this over https.
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: ScorerLinkStatus }) {
  const [label, color] = describe(status);
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${color}`} />
      <span className="text-sm text-gray-300">{label}</span>
    </div>
  );
}

function describe(status: ScorerLinkStatus): [string, string] {
  switch (status) {
    case 'active':
      return ['Scoring for a player', 'bg-green-500'];
    case 'waiting':
      return ['Paired — not in use', 'bg-blue-500'];
    case 'connecting':
      return ['Connecting…', 'bg-yellow-500'];
    default:
      return ['Not paired', 'bg-gray-600'];
  }
}
