import type { VideoFeedId } from '../../shared/media';
import type { VideoFeedView } from '../hooks/useVideoFeed';
import { Box, Button, Group, Text } from '@mantine/core';

interface Props {
  feeds: readonly VideoFeedView[];
  onAccept: (feedId: VideoFeedId) => void;
  onDecline: (feedId: VideoFeedId) => void;
}

/** Persistent per-offer controls, including feeds currently hidden by turn selection. */
export function VideoFeedControls({ feeds, onAccept, onDecline }: Props) {
  // A broken transport can recover and must not strand the viewer's choice. Decoder support cannot
  // recover during the page lifetime, and such offers have already been declined automatically.
  const controls = feeds.filter((feed) => feed.choice !== 'pending' && feed.decoderSupported);
  if (controls.length === 0) return null;

  return (
    <Box pos="absolute" top={8} left={8} style={{ zIndex: 20, maxWidth: 'calc(100% - 1rem)' }}>
      <Group gap={4} wrap="wrap">
      {controls.map((feed) => {
        const accepted = feed.choice === 'accepted';
        const label = feed.label ?? 'board video';
        return (
          <Button
            key={feed.feedId}
            onClick={() => accepted ? onDecline(feed.feedId) : onAccept(feed.feedId)}
            aria-label={`${accepted ? 'Stop' : 'Play'} live video from ${label}`}
            variant="filled"
            color="dark"
            size="compact-xs"
            leftSection={<span aria-hidden="true">{accepted ? '×' : '▶'}</span>}
            maw="12rem"
          >
            <Text span truncate fz="xs">{label}</Text>
          </Button>
        );
      })}
      </Group>
    </Box>
  );
}
