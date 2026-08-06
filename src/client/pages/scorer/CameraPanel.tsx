import { useEffect, useState } from 'react';
import type { useVisionRuntime } from '../../hooks/useVisionRuntime';

type Vision = ReturnType<typeof useVisionRuntime>;

interface CameraPanelProps {
  vision: Vision;
}

/**
 * The camera half of the device: preview, which camera, and the motion gate.
 *
 * The arm / disarm / scan buttons and the two overlay layers are handed to the motion detector,
 * which binds their clicks and drives their disabled and display state directly. React renders
 * them and then leaves them alone.
 */
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
        <div ref={refs.highlights} className="absolute inset-0 pointer-events-none" />
        <div
          ref={refs.metrics}
          className="absolute top-2 left-2 px-2 py-1 text-xs font-mono bg-black/60 rounded pointer-events-none"
        />
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
        {/* Owned by the motion detector: it binds these clicks and manages their state. */}
        <button ref={refs.arm} className="flex-1 px-3 py-2 bg-green-700 hover:bg-green-600 disabled:bg-gray-800 rounded transition-colors">
          Watch board
        </button>
        <button ref={refs.disarm} className="flex-1 px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded transition-colors">
          Stop watching
        </button>
        <button ref={refs.trigger} className="px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded transition-colors">
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
