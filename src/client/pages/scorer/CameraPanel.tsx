import { useEffect, useState } from 'react';
import type { useVisionRuntime } from '../../hooks/useVisionRuntime';
import { Slider } from './Slider';

type Vision = ReturnType<typeof useVisionRuntime>;

interface CameraPanelProps {
  vision: Vision;
}

/**
 * The camera half of the device: preview, which camera, and the motion gate.
 *
 * Every control here is ordinary React. The gate reports what it is doing — armed, sampling at this
 * rate, these tiles just changed — and this decides what that looks like. Nothing outside this file
 * writes to these nodes.
 */
/** The badge's dot: what the gate is doing right now. */
const DOT: Record<string, string> = {
  idle: 'bg-gray-500',
  pending: 'bg-yellow-400',
  triggered: 'bg-green-400',
};

export function CameraPanel({ vision }: CameraPanelProps) {
  const { refs } = vision;
  const [selected, setSelected] = useState('');

  // Once a camera list arrives, pre-select the one this device used last.
  useEffect(() => {
    if (selected || vision.cameras.length === 0) return;
    setSelected(vision.cameras[0].deviceId);
  }, [vision.cameras, selected]);

  const enable = async () => {
    const found = await vision.listCameras();
    if (found.length === 0) return;
    const runtime = vision.runtimeRef.current;
    const preferred = runtime?.preferredCamera(found) ?? found[0];
    setSelected(preferred.deviceId);
    await vision.start(preferred.deviceId);
  };

  return (
    <div className="w-full max-w-md flex flex-col gap-3">
      <div className="relative aspect-square w-full bg-black rounded-lg overflow-hidden">
        <video
          ref={refs.video}
          id="preview"
          playsInline
          muted
          autoPlay
          className="w-full h-full object-cover"
        />
        {/* Where the gate saw movement, one fading square per tile. */}
        <div className="absolute inset-0 pointer-events-none">
          {vision.motionTiles.map((tile) => (
            <div
              key={tile.id}
              className="absolute border border-green-400/70 bg-green-400/10 rounded-sm"
              style={{ left: `${tile.left}%`, top: `${tile.top}%`, width: `${tile.width}%`, height: `${tile.height}%` }}
            />
          ))}
        </div>
        {vision.motion.fps !== null && (
          <div className="absolute top-2 left-2 px-2 py-1 text-xs font-mono bg-black/60 rounded pointer-events-none flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${DOT[vision.motion.dot]}`} />
            detector: {vision.motion.fps.toFixed(1)}fps
          </div>
        )}
        {!vision.cameraActive && (
          <div className="absolute inset-0 flex items-center justify-center">
            <button
              onClick={enable}
              disabled={!vision.ready}
              className="px-6 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 rounded-lg font-semibold transition-colors"
            >
              {vision.ready ? 'Start camera' : 'Loading model…'}
            </button>
          </div>
        )}
      </div>

      {/* Zoom lives here rather than in the settings: framing the board is the first thing anyone
          does at a mount, and it is judged against the picture directly above it. */}
      {vision.cameraActive && vision.zoomRange && (
        <Slider
          label="Zoom"
          value={vision.zoom}
          min={vision.zoomRange.min}
          max={vision.zoomRange.max}
          step={vision.zoomRange.step}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(v) => void vision.applyZoom(v)}
          hint="Zoom in until the board fills the frame. Calibrate the lens afterwards — zoom changes the distortion it is correcting."
        />
      )}

      {vision.cameras.length > 1 && (
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            void vision.start(e.target.value);
          }}
          className="px-3 py-2 bg-gray-900 border border-gray-700 rounded"
        >
          {vision.cameras.map((camera) => (
            <option key={camera.deviceId} value={camera.deviceId}>
              {camera.label}
            </option>
          ))}
        </select>
      )}

      <div className="flex gap-2">
        {vision.motion.armed ? (
          <button
            onClick={() => vision.runtimeRef.current?.motion.disarm()}
            className="flex-1 px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded transition-colors"
          >
            Stop watching
          </button>
        ) : (
          <button
            onClick={() => vision.runtimeRef.current?.motion.arm()}
            disabled={!vision.motion.canArm}
            className="flex-1 px-3 py-2 bg-green-700 hover:bg-green-600 disabled:bg-gray-800 rounded transition-colors"
          >
            Watch board
          </button>
        )}
        <button
          onClick={() => void vision.runtimeRef.current?.infer()}
          disabled={!vision.motion.canTrigger}
          className="px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded transition-colors"
        >
          Scan now
        </button>
        {vision.cameraActive && (
          <button
            onClick={() => void vision.stop()}
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded transition-colors"
          >
            Off
          </button>
        )}
      </div>

      <FrameInfo vision={vision} />
      {vision.error && <p className="text-sm text-red-400">{vision.error}</p>}
    </div>
  );
}

function FrameInfo({ vision }: { vision: Vision }) {
  const frame = vision.frame;
  if (!frame) {
    return <p className="text-sm text-gray-500 h-5">{vision.status?.text ?? ''}</p>;
  }
  const result = frame.result;
  return (
    <p className="text-sm text-gray-400 h-5" data-testid="frame-info">
      {result
        ? `${result.boardKeypoints} board points, ${result.tips.length} tips`
        : 'board not found'}
      {` · ${Math.round(frame.ms)}ms · ${frame.accelerator}`}
    </p>
  );
}
