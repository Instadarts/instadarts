import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, SimpleGrid, Stack, Text } from '@mantine/core';
import { computeDistortionCorrectedSpider, type SpiderProjection } from '../../vision/lensGeometry';
import { sliderValueToLensK1 } from '../../../shared/vision/lensDistortion';
import type { Keypoint } from '../../../shared/vision/types';
import type { useVisionRuntime } from '../../hooks/useVisionRuntime';
import { Slider } from './Slider';
import { AppCard } from '../../components/AppCard';
import { SquareViewport } from './SquareCameraViewport';

type Vision = ReturnType<typeof useVisionRuntime>;

interface CalibrationViewProps {
  vision: Vision;
  onClose: () => void;
}

const STILL_SIZE = 640;

/**
 * Lens calibration, on a frozen frame with the projected board drawn over it.
 *
 * Both properties are load-bearing, and both come from the reference, where they were arrived at
 * against real phones:
 *
 *   · **Frozen.** The phone is hand-held while the slider is dragged and the mount is nudged. An
 *     overlay over a live preview moves with every wobble, so you end up chasing the picture
 *     instead of measuring the lens. One frame is captured on entry and everything is judged
 *     against that; "New frame" takes another.
 *   · **Zoomable.** The judgement is "does this line sit on that wire", on a phone screen showing a
 *     board three metres away. Tap magnifies 4× about the point tapped, so the wire you are
 *     looking at stays under your thumb; tap again to reset.
 *
 * The still is the exact square the model was fed, so image and overlay share one coordinate space.
 */
export function CalibrationView({ vision, onClose }: CalibrationViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [keypoints, setKeypoints] = useState<Keypoint[]>([]);
  const [zoomed, setZoomed] = useState(false);
  const [message, setMessage] = useState('');

  const lensValue = vision.settings.lensByCamera[vision.cameraLabel] ?? 0;

  // The projection is what the slider is judged against, so it is also what decides whether the
  // slider means anything: without a homography there is no drawn board to line up with the wires.
  const projection = useMemo(
    () => (keypoints.length > 0 ? computeDistortionCorrectedSpider(keypoints, sliderValueToLensK1(lensValue)) : null),
    [keypoints, lensValue],
  );
  const hasBoard = projection?.canCompute === true;

  const capture = useCallback(async () => {
    const runtime = vision.runtimeRef.current;
    if (!runtime) return;
    if (!runtime.camera.active) {
      setMessage('Start the camera before calibrating.');
      return;
    }
    setMessage('Capturing a frame…');
    runtime.setKeepInputFrame(true);
    await runtime.infer();

    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, STILL_SIZE, STILL_SIZE);
    const drawn = runtime.drawInputFrame(ctx, STILL_SIZE);
    const found = vision.frameRef.current?.keypoints ?? [];
    setKeypoints(found);
    setMessage(
      !drawn
        ? 'No frame yet — try again.'
        : found.length === 0
          ? 'The board was not found in that frame.'
          : 'Slide until the lines sit on the wires — tap the picture to zoom in.',
    );
  }, [vision.runtimeRef, vision.frameRef]);

  // Motion is paused while calibrating: an inference firing underneath would replace the frame the
  // slider is being judged against.
  useEffect(() => {
    const runtime = vision.runtimeRef.current;
    runtime?.motion.disarm();
    void capture();
    return () => {
      runtime?.setKeepInputFrame(false);
    };
  }, [capture, vision.runtimeRef]);

  const handleTap = (event: React.MouseEvent<HTMLDivElement>) => {
    const element = layer.current;
    if (!element) return;
    if (zoomed) {
      element.style.transform = '';
      element.style.transformOrigin = '';
      setZoomed(false);
      return;
    }
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.min(Math.max(((event.clientX - rect.left) / rect.width) * 100, 0), 100);
    const y = Math.min(Math.max(((event.clientY - rect.top) / rect.height) * 100, 0), 100);
    element.style.transformOrigin = `${x}% ${y}%`;
    element.style.transform = 'scale(4)';
    setZoomed(true);
  };

  return (
    <AppCard title="Lens calibration" padding={0}>
      <Stack gap={0}>
        <SquareViewport>
          <Box ref={layer} onClick={handleTap} pos="absolute" inset={0} style={{ cursor: 'zoom-in' }}>
          <canvas ref={canvas} width={STILL_SIZE} height={STILL_SIZE} style={{ display: 'block', width: '100%', height: '100%' }} />
          <Spider keypoints={keypoints} projection={projection} />
          </Box>
        </SquareViewport>

        <Stack gap="md" p="md">
          <Text fz="sm" c="dimmed" mih="1.25rem">{message || ' '}</Text>

          <Slider
            label="Lens correction"
            value={lensValue}
            min={-100}
            max={100}
            step={1}
            format={(v) => (v > 0 ? `+${v}` : String(v))}
            onChange={(v) => vision.setLens(v)}
            disabled={!hasBoard}
            hint={hasBoard ? undefined : 'Capture a frame the board is visible in to enable this.'}
          />

          <SimpleGrid cols={2} spacing="xs">
            <Button variant="default" onClick={() => void capture()}>New frame</Button>
            <Button onClick={onClose}>Done</Button>
          </SimpleGrid>
        </Stack>
      </Stack>
    </AppCard>
  );
}

/**
 * The board's spider, projected back into the still's own coordinates. Plain lines on purpose:
 * this is a measuring instrument, and anything animated would make it harder to judge.
 */
function Spider({ keypoints, projection }: { keypoints: Keypoint[]; projection: SpiderProjection | null }) {
  if (keypoints.length === 0) return null;

  const path = (points: [number, number][]) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(' ');

  return (
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      {projection?.canCompute && (
        <g fill="none" stroke="#38bdf8" strokeWidth={0.002} vectorEffect="non-scaling-stroke">
          {projection.rings.map((ring, i) => <path key={`r${i}`} d={path(ring)} />)}
          {projection.radials.map((radial, i) => <path key={`s${i}`} d={path(radial)} opacity={0.6} />)}
        </g>
      )}
      {/* The detected keypoints themselves, so a mismatch between what the model saw and where the
          geometry thinks the board is stays visible rather than having to be inferred. */}
      {keypoints.map((kp, i) => (
        <circle
          key={i}
          cx={kp[0]}
          cy={kp[1]}
          r={0.006}
          fill={kp[3] === 8 ? '#f87171' : '#4ade80'}
        />
      ))}
    </svg>
  );
}
