import type { VideoFeedId } from '../../shared/media';

interface Props {
  feedId: VideoFeedId;
  label?: string;
  onAccept: (feedId: VideoFeedId) => void;
  onDecline: (feedId: VideoFeedId) => void;
}

/** One explicit choice at a time; the caller owns the stable queue of later offers. */
export function VideoOfferDialog({ feedId, label, onAccept, onDecline }: Props) {
  const source = label ?? 'A board camera';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-offer-title"
        aria-describedby="video-offer-description"
        className="w-full max-w-sm rounded-xl bg-gray-900 p-5 shadow-2xl"
      >
        <h2 id="video-offer-title" className="text-xl font-semibold">Live board video</h2>
        <p id="video-offer-description" className="mt-2 text-gray-300">{source} is offering a live video feed.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={() => onDecline(feedId)}
            className="rounded bg-gray-700 px-4 py-2 hover:bg-gray-600"
          >
            Use virtual board
          </button>
          <button
            type="button"
            onClick={() => onAccept(feedId)}
            className="rounded bg-green-600 px-4 py-2 font-semibold hover:bg-green-500"
          >
            Show video
          </button>
        </div>
      </div>
    </div>
  );
}
