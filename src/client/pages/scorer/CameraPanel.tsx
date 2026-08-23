import { useEffect, useState } from 'react';
import { Alert, Box, Button, Group, NativeSelect, SimpleGrid, Stack, Text } from '@mantine/core';
import type { useVisionRuntime } from '../../hooks/useVisionRuntime';
import { MOTION_GRID_COLS, MOTION_GRID_ROWS } from '../../vision/motion';
import { AppCard } from '../../components/AppCard';
import { Slider } from './Slider';
import { SquareCameraPreview } from './SquareCameraViewport';

type Vision = ReturnType<typeof useVisionRuntime>;

interface CameraPanelProps {
  vision: Vision;
  /** The device switched the camera off to save battery, rather than the camera failing. */
  poweredDown: boolean;
  /** Render the motion-tile overlay. Defaults to true; turn off on slower phones. */
  motionAnimations?: boolean;
}

/**
 * The camera half of the device: preview, which camera, and the motion gate.
 *
 * Every control here is ordinary React. The gate reports what it is doing — armed, sampling at this
 * rate, these tiles just changed — and this decides what that looks like. Nothing outside this file
 * writes to these nodes.
 */
export function CameraPanel({ vision, poweredDown, motionAnimations = true }: CameraPanelProps) {
  const { refs } = vision;
  const [selected, setSelected] = useState('');

  // Once a camera list arrives, pre-select the one this device used last.
  useEffect(() => {
    if (selected || vision.cameras.length === 0) return;
    setSelected(vision.cameras[0].deviceId);
  }, [vision.cameras, selected]);

  // Whichever camera opened is the one the picker should be showing.
  useEffect(() => {
    if (vision.cameraActive && vision.cameraLabel) {
      const opened = vision.cameras.find((c) => c.label === vision.cameraLabel);
      if (opened) setSelected(opened.deviceId);
    }
  }, [vision.cameraActive, vision.cameraLabel, vision.cameras]);

  return (
    <AppCard title="Camera" padding={0}>
      <Stack gap={0}>
        <SquareCameraPreview videoRef={refs.video} id="preview">
        {/* Where the gate saw movement, one fading square per tile. The grid is pre-rendered once —
            CSS toggles opacity; no DOM is created or destroyed after mount. */}
        {motionAnimations && (
          <Box pos="absolute" inset={0} style={{ pointerEvents: 'none' }}>
            {Array.from({ length: MOTION_GRID_ROWS * MOTION_GRID_COLS }, (_, i) => {
              const row = Math.floor(i / MOTION_GRID_COLS);
              const col = i % MOTION_GRID_COLS;
              const active = vision.activeTiles.has(i);
              return (
                <Box
                  key={i}
                  pos="absolute"
                  style={{
                    left: `${(col / MOTION_GRID_COLS) * 100}%`,
                    top: `${(row / MOTION_GRID_ROWS) * 100}%`,
                    width: `${100 / MOTION_GRID_COLS}%`,
                    height: `${100 / MOTION_GRID_ROWS}%`,
                    border: '1px solid rgba(74, 222, 128, 0.7)',
                    borderRadius: 2,
                    background: 'rgba(74, 222, 128, 0.1)',
                    opacity: active ? 1 : 0,
                    transition: active ? undefined : 'opacity 450ms',
                  }}
                />
              );
            })}
          </Box>
        )}
        {vision.motion.fps !== null && (
          <Group pos="absolute" top={8} left={8} gap={6} wrap="nowrap" px="xs" py={4} bg="rgba(0, 0, 0, 0.6)" style={{ borderRadius: 'var(--mantine-radius-sm)', pointerEvents: 'none' }}>
            <Box pos="relative" w={8} h={8} style={{ flexShrink: 0 }}>
              {/* Bottom: gray when idle or triggered, yellow/amber when motion is pending. */}
              <Box pos="absolute" inset={0} bg={
                vision.motion.dot === 'pending' ? 'yellow.3'
                  : vision.motion.dot === 'pendingLarge' ? 'orange.7'
                    : 'gray.6'
              } style={{ borderRadius: '50%' }} />
              {/* Top: green when inference fired, fades out over 1s. */}
              <Box
                pos="absolute"
                inset={0}
                bg="green.4"
                style={{
                  borderRadius: '50%',
                  opacity: vision.motion.dot === 'triggered' ? 1 : 0,
                  transition: vision.motion.dot === 'triggered' ? undefined : 'opacity 1s',
                }}
              />
            </Box>
            <Text fz="xs" ff="monospace">
              {vision.motion.mode === 'gpu-bitmap' ? 'gpu' : vision.motion.mode}-detector: {vision.motion.fps.toFixed(1)}fps
            </Text>
          </Group>
        )}
        {vision.cameraResolution && (
          <Text pos="absolute" top={8} right={8} px="xs" py={4} fz="xs" ff="monospace" bg="rgba(0, 0, 0, 0.6)" style={{ borderRadius: 'var(--mantine-radius-sm)', pointerEvents: 'none' }}>
            {vision.cameraResolution}
          </Text>
        )}
        {!vision.cameraActive && (
          <Stack pos="absolute" inset={0} align="center" justify="center" gap="sm" p="md">
            {/* A camera that was switched off on purpose is not a camera that failed, and the
                difference is the whole answer to "why is this thing not working". */}
            {poweredDown && (
              <Text fz="sm" c="gray.4" data-testid="powered-down">
                Camera off to save battery
              </Text>
            )}
            <Button
              onClick={() => void vision.startPreferred()}
              disabled={!vision.ready}
              size="lg"
            >
              {!vision.ready ? 'Loading model…' : poweredDown ? 'Resume' : 'Start camera'}
            </Button>
          </Stack>
        )}
        </SquareCameraPreview>

        <Stack gap="md" p="md">
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
            <NativeSelect
              label="Camera"
              value={selected}
              onChange={(event) => {
                setSelected(event.currentTarget.value);
                void vision.start(event.currentTarget.value);
              }}
              data={vision.cameras.map((camera) => ({ value: camera.deviceId, label: camera.label }))}
            />
          )}

          <SimpleGrid minColWidth={140} spacing="xs">
            {/* "Watch board" described how it works — a motion detector — to somebody who has no reason
                to know there is one. What it means to whoever mounted the phone is that scanning either
                happens by itself or only when they ask, so these two say exactly that. */}
            {vision.motion.armed ? (
              <Button variant="default" onClick={() => vision.runtimeRef.current?.motion.disarm()}>
                Stop scanning
              </Button>
            ) : (
              <Button onClick={() => vision.runtimeRef.current?.motion.arm()} disabled={!vision.motion.canArm}>
                Scan automatically
              </Button>
            )}
            <Button variant="default" onClick={() => void vision.runtimeRef.current?.infer()} disabled={!vision.motion.canTrigger}>
              Scan now
            </Button>
            {vision.cameraActive && (
              <Button variant="subtle" color="gray" onClick={() => void vision.stop()}>
                Off
              </Button>
            )}
          </SimpleGrid>

          <FrameInfo vision={vision} />
          {vision.error && <Alert color="red">{vision.error}</Alert>}
        </Stack>
      </Stack>
    </AppCard>
  );
}

function FrameInfo({ vision }: { vision: Vision }) {
  const frame = vision.frame;
  return (
    <Text fz="sm" c="gray.4" mih="1.25rem" data-testid="frame-info">
      {frame ? (
        <>
          {frame.result
            ? `${frame.result.boardKeypoints} board points, ${frame.result.tips.length} tips`
            : 'board not found'}
          {` · ${Math.round(frame.ms)}ms · inference ${frame.accelerator} · preprocessing ${frame.preprocessMode}`}
        </>
      ) : vision.status?.text ?? ' '}
    </Text>
  );
}
