import { Button, Group, Modal, Text } from '@mantine/core';
import type { VideoFeedId } from '../../shared/media';

interface Props {
  feedId: VideoFeedId;
  label?: string;
  onAccept: (feedId: VideoFeedId) => void;
  onDecline: (feedId: VideoFeedId) => void;
}

export function VideoOfferDialog({ feedId, label, onAccept, onDecline }: Props) {
  const source = label ?? 'A board camera';
  return (
    <Modal
      opened
      onClose={() => onDecline(feedId)}
      title="Live board video"
      centered
      size="sm"
      overlayProps={{ backgroundOpacity: 0.75 }}
    >
      <Text c="dimmed">{source} is offering a live video feed.</Text>
      <Group justify="flex-end" mt="lg">
        <Button variant="default" autoFocus onClick={() => onDecline(feedId)}>Use virtual board</Button>
        <Button onClick={() => onAccept(feedId)}>Show video</Button>
      </Group>
    </Modal>
  );
}
