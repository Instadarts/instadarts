import { Box } from '@mantine/core';
import type { DartThrow } from '../../shared/types';
import type { VideoFeedId } from '../../shared/media';
import type { VideoFeedView } from '../hooks/useVideoFeed';
import { Dartboard } from './Dartboard';
import { LiveBoardFeed } from './LiveBoardFeed';
import { VideoFeedControls } from './VideoFeedControls';

export interface LiveBoardView {
  canvas: HTMLCanvasElement;
  label?: string;
}

interface VirtualBoardProps {
  darts: DartThrow[];
  dartsPerVisit: number;
  onAddDart: (dart: DartThrow) => void;
  disabled?: boolean;
  liveBoard?: LiveBoardView | null;
  videoOffers?: readonly VideoFeedView[];
  onAcceptVideo?: (feedId: VideoFeedId) => void;
  onDeclineVideo?: (feedId: VideoFeedId) => void;
}

/** The board input surface and overlays that must remain aligned with that surface. */
export function VirtualBoard({
  darts,
  dartsPerVisit,
  onAddDart,
  disabled,
  liveBoard,
  videoOffers = [],
  onAcceptVideo = () => {},
  onDeclineVideo = () => {},
}: VirtualBoardProps) {
  return (
    <Box className="frontend-board-area">
      <Dartboard darts={darts} maxDarts={dartsPerVisit} onDartClick={onAddDart} disabled={disabled}>
        {liveBoard && <LiveBoardFeed source={liveBoard.canvas} label={liveBoard.label} />}
        <VideoFeedControls feeds={videoOffers} onAccept={onAcceptVideo} onDecline={onDeclineVideo} />
      </Dartboard>
    </Box>
  );
}
