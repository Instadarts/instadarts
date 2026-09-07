import { AspectRatio, Box, UnstyledButton } from '@mantine/core';
import { CameraIcon } from './AppIcons';

interface DartEvidenceProps {
  image?: string;
  index: number;
  unavailable: boolean;
  onOpen: (image: string) => void;
}

export function DartEvidence({ image, index, unavailable, onOpen }: DartEvidenceProps) {
  return (
    <AspectRatio
      ratio={1}
      bg="var(--instadarts-surface-raised)"
      w="100%"
      data-testid="dart-evidence"
      style={{
        borderRadius: 'var(--mantine-radius-sm)',
        maxWidth: '100cqh',
        overflow: 'hidden',
      }}
    >
      {image ? (
        <UnstyledButton
          onClick={() => onOpen(image)}
          aria-label={`Dart ${index + 1} evidence`}
          style={{ cursor: 'zoom-in', display: 'block' }}
        >
          <img src={image} alt="" style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
        </UnstyledButton>
      ) : (
        <Box
          role={unavailable ? 'img' : undefined}
          aria-label={unavailable ? `Dart ${index + 1} evidence unavailable` : undefined}
          c="var(--instadarts-surface)"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {unavailable && <CameraIcon crossedOut size="40%" />}
        </Box>
      )}
    </AspectRatio>
  );
}
