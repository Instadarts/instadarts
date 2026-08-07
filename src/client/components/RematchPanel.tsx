import type { MatchState } from '../../shared/types';

interface RematchPanelProps {
  match: MatchState;
  /** This user's session. A user answers for their own players — in a local match, for all of them. */
  sessionId: string | null;
  onVote: (playerId: string, accepted: boolean) => void;
}

/**
 * "Play again?", one toggle per participant.
 *
 * Everyone accepting starts a re-match at once — a new match with the same rules and participants,
 * in the opposite order, with no lobby in between. The votes live on the match state, so each side
 * watches the other's toggle through the ordinary broadcast.
 *
 * Nothing is offered once someone has left: leaving a match is final, and the person who would have
 * to agree is gone.
 */
export function RematchPanel({ match, sessionId, onVote }: RematchPanelProps) {
  if (match.departed.length > 0) return null;

  const mine = (playerId: string) =>
    match.isLocal || match.players.find((p) => p.id === playerId)?.sessionId === sessionId;

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-gray-400 text-sm uppercase">Play again?</p>
      <div className="flex gap-4">
        {match.players.map((player) => {
          const accepted = match.rematchVotes.includes(player.id);
          const canAnswer = mine(player.id);
          return (
            <button
              key={player.id}
              onClick={() => canAnswer && onVote(player.id, !accepted)}
              disabled={!canAnswer}
              aria-pressed={accepted}
              className={`px-6 py-4 rounded-lg border-2 min-w-[150px] transition-colors ${
                accepted
                  ? 'bg-green-900 border-green-500 text-green-300'
                  : 'bg-gray-900 border-gray-700 text-gray-300'
              } ${canAnswer ? 'hover:border-green-500 cursor-pointer' : 'opacity-70 cursor-default'}`}
            >
              <span className="block text-lg font-semibold">{player.name}</span>
              <span className="block text-sm mt-1">
                {accepted ? '✓ Ready' : canAnswer ? 'Tap to accept' : 'Waiting…'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
