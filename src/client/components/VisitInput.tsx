import { Box, Button, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import type { DartThrow, ViewText } from '../../shared/types';
import { styleOf, textOf } from '../../shared/types';
import { Dartboard } from './Dartboard';
import { DartEvidence } from './DartEvidence';
import { modeTextProps, slotStyle } from './modeText';
import { LiveBoardFeed } from './LiveBoardFeed';
import { VideoFeedControls } from './VideoFeedControls';
import type { VideoFeedId } from '../../shared/media';
import type { VideoFeedView } from '../hooks/useVideoFeed';

export interface LiveBoardView {
  canvas: HTMLCanvasElement;
  label?: string;
}

interface VisitInputProps {
  darts: DartThrow[];
  dartsPerVisit: number;
  slots?: ViewText[];
  visitTotal: ViewText;
  onAddDart: (dart: DartThrow) => void;
  onUndoDart: () => void;
  onSubmit: () => void;
  disabled?: boolean;
  locked?: boolean;
  readOnly?: boolean;
  hideActions?: boolean;
  evidence: (string | undefined)[] | null;
  liveBoard?: LiveBoardView | null;
  videoOffers?: readonly VideoFeedView[];
  onAcceptVideo?: (feedId: VideoFeedId) => void;
  onDeclineVideo?: (feedId: VideoFeedId) => void;
}

export function VisitInput({
  darts,
  dartsPerVisit,
  slots,
  visitTotal,
  onAddDart,
  onUndoDart,
  onSubmit,
  disabled,
  locked,
  readOnly,
  hideActions,
  evidence,
  liveBoard,
  videoOffers = [],
  onAcceptVideo = () => {},
  onDeclineVideo = () => {},
}: VisitInputProps) {
  const boardDisabled = disabled || darts.length >= dartsPerVisit || (locked ?? false) || (readOnly ?? false);
  const filled: ViewText[] = slots ?? darts.map((dart) => `${dart.score.label} (${dart.score.points})`);
  const empty = Math.max(0, dartsPerVisit - filled.length);

  return (
    <Stack gap="sm" h="100%" align="stretch">
      <Box className="frontend-board-area">
        <Dartboard darts={darts} maxDarts={dartsPerVisit} onDartClick={onAddDart} disabled={boardDisabled}>
          {liveBoard && <LiveBoardFeed source={liveBoard.canvas} label={liveBoard.label} />}
          <VideoFeedControls feeds={videoOffers} onAccept={onAcceptVideo} onDecline={onDeclineVideo} />
        </Dartboard>
      </Box>

      <SimpleGrid cols={dartsPerVisit} spacing="sm" data-visit-slots>
        {filled.map((slot, index) => (
          <Paper
            key={index}
            py={5}
            px="xs"
            radius="sm"
            ta="center"
            ff="monospace"
            data-slot-size={styleOf(slot).size ?? 'lg'}
            data-slot-tone={styleOf(slot).tone ?? 'default'}
            style={slotStyle(slot, { size: 'lg' })}
          >
            {textOf(slot)}
          </Paper>
        ))}
        {Array.from({ length: empty }).map((_, index) => (
          <Paper key={`empty-${index}`} py={5} px="xs" radius="sm" ta="center" ff="monospace" bg="dark.6" c="gray.6" fz="lg">
            --
          </Paper>
        ))}
      </SimpleGrid>

      {evidence && <DartEvidence images={evidence} slots={dartsPerVisit} />}

      {textOf(visitTotal) !== '' && (
        <Text ta="center" {...modeTextProps(visitTotal, { tone: 'warning', size: 'xl', weight: 'bold' })}>
          Visit: {textOf(visitTotal)}
        </Text>
      )}

      {!hideActions && (
        <Group justify="center" gap="sm">
          <Button variant="default" onClick={onUndoDart} disabled={darts.length === 0 || (readOnly ?? false)}>Undo</Button>
          <Button onClick={onSubmit} disabled={readOnly ?? false}>Submit Visit</Button>
        </Group>
      )}
    </Stack>
  );
}
