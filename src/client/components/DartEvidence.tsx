import { AspectRatio, Box, Modal, SimpleGrid, UnstyledButton } from '@mantine/core';
import { useState } from 'react';

interface DartEvidenceProps {
  images: (string | undefined)[];
  slots: number;
  spacing: number;
}

const EVIDENCE_STRIP_MAX_WIDTH = 480;

export function DartEvidence({ images, slots, spacing }: DartEvidenceProps) {
  const [open, setOpen] = useState<string | null>(null);
  const maximumTileWidth = (
    EVIDENCE_STRIP_MAX_WIDTH - Math.max(0, slots - 1) * spacing
  ) / Math.max(1, slots);

  return (
    <>
      <SimpleGrid cols={slots} spacing={spacing} w="100%" data-testid="dart-evidence">
        {Array.from({ length: slots }).map((_, index) => {
          const src = images[index];
          return (
            <AspectRatio
              key={index}
              ratio={1}
              bg="dark.6"
              w="100%"
              maw={maximumTileWidth}
              mx="auto"
              style={{ overflow: 'hidden', borderRadius: 'var(--mantine-radius-sm)' }}
            >
              {src ? (
                <UnstyledButton onClick={() => setOpen(src)} aria-label={`Dart ${index + 1} evidence`} style={{ cursor: 'zoom-in' }}>
                  <img src={src} alt="" style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
                </UnstyledButton>
              ) : <Box />}
            </AspectRatio>
          );
        })}
      </SimpleGrid>

      <Modal opened={open !== null} onClose={() => setOpen(null)} title="Dart evidence" centered size="auto">
        {open && <img src={open} alt="" style={{ display: 'block', maxWidth: '90vw', maxHeight: '80dvh', objectFit: 'contain' }} />}
      </Modal>
    </>
  );
}
