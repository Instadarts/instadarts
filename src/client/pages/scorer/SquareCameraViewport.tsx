import { Box } from '@mantine/core';
import type { ReactNode, Ref } from 'react';

interface SquareViewportProps {
  children: ReactNode;
  background?: string;
  withBorder?: boolean;
  radius?: string | number;
}

/**
 * The scorer's model-input viewport.
 *
 * A centered cover crop inside a square is the presentation equivalent of getCenterSquareCrop:
 * the source's longer axis is clipped equally at both ends. Keep every normalized overlay inside
 * this same box so it shares the model's coordinate space.
 */
export function SquareViewport({
  children,
  background = 'black',
  withBorder = false,
  radius = 0,
}: SquareViewportProps) {
  return (
    <Box
      pos="relative"
      w="100%"
      bg={background}
      style={{
        aspectRatio: '1 / 1',
        border: withBorder ? '1px solid var(--mantine-color-dark-6)' : undefined,
        borderRadius: radius,
        overflow: 'hidden',
      }}
    >
      {children}
    </Box>
  );
}

interface SquareCameraPreviewProps extends Omit<SquareViewportProps, 'children'> {
  videoRef: Ref<HTMLVideoElement>;
  id?: string;
  testId?: string;
  children?: ReactNode;
}

export function SquareCameraPreview({
  videoRef,
  id,
  testId,
  children,
  ...viewport
}: SquareCameraPreviewProps) {
  return (
    <SquareViewport {...viewport}>
      <video
        ref={videoRef}
        id={id}
        playsInline
        muted
        autoPlay
        data-testid={testId}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'center',
        }}
      />
      {children}
    </SquareViewport>
  );
}
