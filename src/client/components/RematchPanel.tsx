import { useEffect, useState } from 'react';
import type { MatchState, RematchAnswer } from '../../shared/types';

interface RematchPanelProps {
  match: MatchState;
  /** This user's own players. A user answers for their own — in a local match, for all of them. */
  ownPlayerIds: string[];
  onVote: (playerId: string, answer: RematchAnswer | 'neutral') => void;
}

/**
 * "Play again?", with a definite answer from every participant.
 *
 * Each player is neutral until they accept or decline. Everyone accepting starts a re-match at once;
 * a single decline settles it. Nobody can leave the question open: walking out counts as a decline,
 * and anything still neutral when the match's deadline arrives becomes one.
 *
 * The votes live on the match state, so each side watches the other's answer through the ordinary
 * broadcast.
 */
export function RematchPanel({ match, ownPlayerIds, onVote }: RematchPanelProps) {
  const answers = match.players.map((p) => match.rematchVotes[p.id]);
  const declined = answers.some((a) => a === 'declined');

  const mine = (playerId: string) => match.isLocal || ownPlayerIds.includes(playerId);

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-gray-400 text-sm uppercase">
        {declined ? 'No re-match' : 'Play again?'}
      </p>

      <div className="flex gap-2">
        {match.players.map((player) => (
          <PlayerVote
            key={player.id}
            name={player.name}
            answer={match.rematchVotes[player.id]}
            canAnswer={!declined && !match.departed.includes(player.id) && mine(player.id)}
            onVote={(answer) => onVote(player.id, answer)}
          />
        ))}
      </div>

      <Countdown until={match.expiresAt} declined={declined} />
    </div>
  );
}

interface PlayerVoteProps {
  name: string;
  answer: RematchAnswer | undefined;
  canAnswer: boolean;
  onVote: (answer: RematchAnswer | 'neutral') => void;
}

function PlayerVote({ name, answer, canAnswer, onVote }: PlayerVoteProps) {
  const press = (next: RematchAnswer) => onVote(answer === next ? 'neutral' : next);

  return (
    <div className="flex flex-col items-center gap-2 min-w-[150px]">
      <span className="text-lg font-semibold text-gray-200">{name}</span>
      <div className="flex gap-2">
        <VoteButton
          label="✓ Yes"
          ariaLabel={`${name}: accept re-match`}
          active={answer === 'accepted'}
          activeClass="bg-green-900 border-green-500 text-green-300"
          disabled={!canAnswer}
          onClick={() => press('accepted')}
        />
        <VoteButton
          label="✕ No"
          ariaLabel={`${name}: decline re-match`}
          active={answer === 'declined'}
          activeClass="bg-red-900 border-red-500 text-red-300"
          disabled={!canAnswer}
          onClick={() => press('declined')}
        />
      </div>
    </div>
  );
}

interface VoteButtonProps {
  label: string;
  ariaLabel: string;
  active: boolean;
  activeClass: string;
  disabled: boolean;
  onClick: () => void;
}

function VoteButton({ label, ariaLabel, active, activeClass, disabled, onClick }: VoteButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`px-5 py-3 rounded-lg border-2 text-base font-semibold transition-colors ${
        active ? activeClass : 'bg-gray-900 border-gray-700 text-gray-400'
      } ${disabled ? 'opacity-60 cursor-default' : 'hover:border-gray-500 cursor-pointer'}`}
    >
      {label}
    </button>
  );
}

/** How long the match has left. It is what turns an unanswered vote into a decline. */
function Countdown({ until, declined }: { until: number; declined: boolean }) {
  const [remaining, setRemaining] = useState(() => until - Date.now());

  useEffect(() => {
    setRemaining(until - Date.now());
    const timer = setInterval(() => setRemaining(until - Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);

  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <p className="text-gray-500 text-sm">
      {declined ? `Closing in ${clock}` : `No answer counts as no, in ${clock}`}
    </p>
  );
}
