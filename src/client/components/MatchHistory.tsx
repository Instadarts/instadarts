import type { MatchState } from '../../shared/types';
import { standingsOf } from '../../shared/matchFormat';

interface MatchHistoryProps {
  match: MatchState;
}

/**
 * How the match was won, set by set — a scoreline, read like tennis.
 *
 * Purely match-level: legs won per set, and nothing about how any of them were played. That is what
 * keeps the summary free of the game mode, and it means this table looks the same whatever was
 * played inside the legs.
 */
export function MatchHistory({ match }: MatchHistoryProps) {
  const standings = standingsOf(match.legs, match.settings);
  // One leg per set makes the set column meaningless — the legs are the story. Display only.
  const byLeg = match.settings.legsToWinSet === 1;

  if (standings.sets.length === 0) {
    return <p className="text-gray-500 text-sm">No legs were played.</p>;
  }

  const columns = byLeg
    ? [{ label: 'Legs', valueFor: (playerId: string) => standings.setWins[playerId] ?? 0 }]
    : standings.sets.map((set, i) => ({
        label: `Set ${i + 1}`,
        valueFor: (playerId: string) => set.legWins[playerId] ?? 0,
      }));

  return (
    <table className="text-sm">
      <thead>
        <tr className="text-gray-500 uppercase text-xs">
          <th className="text-left font-normal pr-6 pb-1">Player</th>
          {columns.map((column) => (
            <th key={column.label} className="px-3 pb-1 font-normal">{column.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {match.players.map((player) => {
          const won = player.id === match.winnerId;
          return (
            <tr key={player.id} className={won ? 'text-green-300' : 'text-gray-400'}>
              <td className="text-left pr-6 py-1">{player.name}</td>
              {columns.map((column) => (
                <td key={column.label} className="px-3 py-1 text-center font-mono">
                  {column.valueFor(player.id)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
