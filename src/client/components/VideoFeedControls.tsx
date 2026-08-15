import type { VideoFeedId } from '../../shared/media';
import type { VideoFeedView } from '../hooks/useVideoFeed';

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
    <div className="absolute left-2 top-2 z-20 flex max-w-[calc(100%-1rem)] flex-wrap gap-1">
      {controls.map((feed) => {
        const accepted = feed.choice === 'accepted';
        const label = feed.label ?? 'board video';
        return (
          <button
            key={feed.feedId}
            type="button"
            onClick={() => accepted ? onDecline(feed.feedId) : onAccept(feed.feedId)}
            aria-label={`${accepted ? 'Stop' : 'Play'} live video from ${label}`}
            className="flex max-w-48 items-center gap-1 rounded bg-black/75 px-2 py-1 text-xs text-white shadow hover:bg-black/90"
          >
            <span aria-hidden="true">{accepted ? '×' : '▶'}</span>
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
