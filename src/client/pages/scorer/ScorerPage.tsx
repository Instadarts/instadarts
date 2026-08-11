import { useCallback, useEffect, useRef, useState } from 'react';
import { useVisionRuntime } from '../../hooks/useVisionRuntime';
import { useScorerPower } from '../../hooks/useScorerPower';
import type { PendingCommand, ScorerLinkStatus } from '../../hooks/useScorerLink';
import type { PowerStage } from '../../lib/scorerPower';
import type { BoardTip } from '../../../shared/vision/types';
import type { MediaTier } from '../../../shared/media';
import type { StillSource } from '../../hooks/useStillResponder';
import type { VideoFrameSource } from '../../media/videoPublisher';
import type { Region } from '../../../shared/media';
import { loadSettings } from '../../lib/scorerStorage';
import { e2eNumber } from '../../lib/e2e';
import { CameraPanel } from './CameraPanel';
import { CalibrationView } from './CalibrationView';
import { FullscreenButton } from '../../components/FullscreenButton';
import { Screensaver } from './Screensaver';
import { SettingsPanel } from './SettingsPanel';
import { LatencyMeter, type LatencySnapshot } from '../../lib/latencyMeter';

interface ScorerPageProps {
  status: ScorerLinkStatus;
  /** A match is running that this device feeds. What its power management turns on. */
  scoring: boolean;
  /** The owner's last instruction, numbered so a repeat is not mistaken for a re-render. */
  command: PendingCommand | null;
  /** This device has given up waiting; the socket should close and stay closed. */
  onStandbyChange: (standby: boolean) => void;
  name: string;
  onRename: (name: string) => void;
  /** The user has finished typing the name — publish it. */
  onNameSettled: () => void;
  onUnpair: () => void;
  onTips: (tips: BoardTip[], ms: number) => void;
  onCameraActive: (active: boolean, error?: string) => void;
  /**
   * Told when this phone changes how much of its view it will share. The answer itself lives in the
   * settings blob like every other; this exists because the mesh above acts on it, and narrowing it
   * should stop a stream somebody is watching right now rather than at the next reload.
   */
  onMediaChange: (tier: MediaTier) => void;
  /**
   * Filled in with whatever can currently take a picture, for the still responder that lives above.
   * The camera is here and the mesh is up there; this is how the two meet.
   */
  stillSource: React.MutableRefObject<StillSource | null>;
  /** The same introduction as `stillSource`, for the live feed's frames. */
  videoSource: React.MutableRefObject<VideoFrameSource | null>;
  /**
   * And for the director's commands.
   *
   * Held apart from `videoSource` because the two have different lifetimes: a region survives a
   * camera restart, since it describes the board rather than any camera.
   */
  directVideo: React.MutableRefObject<((region: Region | null, transitionMs: number, resetMs: number) => void) | null>;
  /**
   * Filled in with a callback the parent calls whenever a still request arrives, so the latency
   * meter can record the end of a measurement. Same pattern as stillSource / videoSource.
   */
  latencyMeterRef?: React.MutableRefObject<{ onStillRequest: () => void } | null>;
}

type View = 'scoring' | 'settings' | 'calibration';

/** The scoring screen: what this device is looking at, and what the match it feeds looks like. */
export function ScorerPage({
  status,
  scoring,
  command,
  onStandbyChange,
  name,
  onRename,
  onNameSettled,
  onUnpair,
  onTips,
  onCameraActive,
  onMediaChange,
  stillSource,
  videoSource,
  directVideo,
  latencyMeterRef,
}: ScorerPageProps) {
  // ── latency meter (dev only) — must be before useVisionRuntime, because the
  //     wrapped onTips callback is passed to it. ─────────────────────────────
  const meter = useRef(new LatencyMeter());
  const [meterSnapshot, setMeterSnapshot] = useState<LatencySnapshot>({ min: null, max: null, avg: null, last: null, count: 0 });

  // Feed tips results into the meter, then forward to the real callback.
  const onTipsWithMeter = useCallback((tips: BoardTip[], ms: number) => {
    meter.current.onTipsReceived(tips.length > 0);
    setMeterSnapshot(meter.current.snapshot());
    onTips(tips, ms);
  }, [onTips]);

  const vision = useVisionRuntime({ onTips: onTipsWithMeter, onCameraActive });

  // Expose the still-request callback for the parent.
  // Deliberately NOT in an effect — the parent reads it during render (same as stillSource).
  if (latencyMeterRef) {
    latencyMeterRef.current = { onStillRequest: () => { meter.current.onStillRequested(); setMeterSnapshot(meter.current.snapshot()); } };
  }

  // Watch motion-dot transitions. React only fires when the string value changes,
  // so repeat 'pending' reports during the settling period are naturally ignored.
  // The motion detector extends its quiet timer internally — the meter should not
  // treat those as new throws.
  const prevDot = useRef(vision.motion.dot);
  useEffect(() => {
    const dot = vision.motion.dot;
    const prev = prevDot.current;
    prevDot.current = dot;

    const isPending = dot === 'pending' || dot === 'pendingLarge';
    if (!isPending) return;

    // idle → pending: first motion after quiet — start a measurement.
    if (prev === 'idle') {
      meter.current.onMotionDetected();
      setMeterSnapshot(meter.current.snapshot());
      return;
    }
    // triggered → pending: inference already fired for the previous throw,
    // and now a new one is starting before the still request arrived — abandon.
    if (prev === 'triggered') {
      meter.current.onMotionReDetected();
      setMeterSnapshot(meter.current.snapshot());
    }
    // pending/pendingLarge → pending/pendingLarge: repeat detection during
    // settling — the motion detector handles this internally, ignore.
  }, [vision.motion.dot]);

  // ── end latency meter ─────────────────────────────────────────

  // Assigned during render rather than in an effect: a still request can arrive before effects have
  // run, and the honest answer to one is the camera as it is now.
  stillSource.current = { capture: vision.captureStill, located: vision.located };
  videoSource.current = { grab: vision.grabVideoFrame, element: vision.videoElement };
  directVideo.current = vision.directVideo;
  const [view, setView] = useState<View>('scoring');
  const [settings, setSettings] = useState(() => loadSettings());

  const startCamera = useCallback(() => { void vision.startPreferred(); }, [vision.startPreferred]);
  const stopCamera = useCallback(() => { void vision.stop(); }, [vision.stop]);

  const power = useScorerPower({
    scoring,
    cameraActive: vision.cameraActive,
    // Minutes are what a person sets; milliseconds are what the timers run on. The overrides exist
    // because no test can wait two minutes, let alone thirty, and do nothing in a shipped build.
    graceMs: e2eNumber('graceMs') ?? settings.cameraOffAfterMinutes * 60_000,
    standbyMs: e2eNumber('standbyMs') ?? settings.standbyAfterMinutes * 60_000,
    startCamera,
    stopCamera,
  });

  useEffect(() => { onStandbyChange(power.standby); }, [power.standby, onStandbyChange]);

  // The owner's instructions, keyed on the sequence rather than the command, so "off, on, off" is
  // three actions rather than two. A camera command counts as activity — one turned on from the
  // other room would otherwise switch itself off two minutes later regardless — while a power-off
  // is the opposite of activity and goes straight to the stage.
  const { noteActivity, powerOff } = power;
  const handledCommand = useRef(0);
  useEffect(() => {
    if (!command || command.seq === handledCommand.current) return;
    handledCommand.current = command.seq;
    switch (command.name) {
      case 'camera_on':
        noteActivity();
        startCamera();
        break;
      case 'camera_off':
        noteActivity();
        stopCamera();
        break;
      case 'power_off':
        powerOff();
        break;
    }
  }, [command, noteActivity, powerOff, startCamera, stopCamera]);

  return (
    <div className="flex-1 flex flex-col items-center p-4 gap-2">
      <div className="w-full max-w-md flex items-center justify-between gap-2">
        <StatusBadge status={status} scoring={scoring} stage={power.stage} />
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
          <FullscreenButton />
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
        <CameraPanel vision={vision} poweredDown={power.stage !== 'awake'} motionAnimations={settings.motionAnimations} />
      </div>

      {view === 'settings' && (
        <SettingsPanel
          vision={vision}
          onCalibrate={() => setView('calibration')}
          settings={settings}
          onSettingsChange={setSettings}
          onUnpair={onUnpair}
          onMediaChange={onMediaChange}
        />
      )}

      {view === 'calibration' && <CalibrationView vision={vision} onClose={() => setView('settings')} />}

      {/* Woken by a match starting or ending, not by a tab claiming the device: the screen should
          come back because somebody is about to throw. */}
      <Screensaver enabled={settings.screensaver} suppressed={view !== 'scoring'} active={scoring} />

      {import.meta.env.DEV && <LatencyDisplay snapshot={meterSnapshot} />}
    </div>
  );
}

/** Dev-only latency readout: min / max / avg / last / count. */
function LatencyDisplay({ snapshot }: { snapshot: LatencySnapshot }) {
  if (snapshot.count === 0) return null;
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center pointer-events-none">
      <div className="bg-black/70 text-green-400 text-xs font-mono px-4 py-1.5 rounded-t-md">
      M2E |  Min: <span className="text-white">{snapshot.min}ms</span>
        {' | '}
        Max: <span className="text-white">{snapshot.max}ms</span>
        {' | '}
        Avg: <span className="text-white">{snapshot.avg}ms</span>
        {' | '}
        Last: <span className="text-white">{snapshot.last}ms</span>
        {' | '}
        N: <span className="text-white">{snapshot.count}</span>
      </div>
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

interface StatusBadgeProps {
  status: ScorerLinkStatus;
  scoring: boolean;
  stage: PowerStage;
}

function StatusBadge({ status, scoring, stage }: StatusBadgeProps) {
  const [label, color] = describe(status, scoring, stage);
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${color}`} />
      <span className="text-sm text-gray-300 hidden" data-testid="scorer-status">{label}</span>
    </div>
  );
}

/**
 * What this device is doing, in the order that matters to whoever is looking at it.
 *
 * Standby comes first because in standby the socket is deliberately shut, and every other status
 * would read that as a fault. `active` used to claim it was scoring for a player whenever a
 * frontend had merely claimed it, which was a lie for most of an evening.
 */
function describe(status: ScorerLinkStatus, scoring: boolean, stage: PowerStage): [string, string] {
  if (stage === 'standby') return ['Asleep — tap to wake', 'bg-gray-600'];
  if (scoring) return ['Scoring for a player', 'bg-green-500'];
  if (stage === 'camera-off') return ['Idle — camera off', 'bg-gray-500'];

  switch (status) {
    case 'active':
      return ['Ready — no match running', 'bg-blue-500'];
    case 'waiting':
      return ['Paired — not in use', 'bg-blue-500'];
    case 'connecting':
      return ['Connecting…', 'bg-yellow-500'];
    case 'full':
      return ['Server is full — try again shortly', 'bg-yellow-500'];
    default:
      return ['Not paired', 'bg-gray-600'];
  }
}
