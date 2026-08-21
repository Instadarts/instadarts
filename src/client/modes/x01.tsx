import type { ModePanelProps } from './panels';
import type { ModePanel } from '../../shared/types';
import { textOf } from '../../shared/types';

// x01's optional second file.
//
// A game mode is one file on the server; this is the other half a mode may add when it wants to draw
// its panel itself. It is found by filename — `src/client/modes/x01.tsx` — with no registry to edit,
// and deleting it costs nothing: the match screen falls back to rendering the same rows as a plain
// table. Everything below is presentation.
//
// It reads two things: the `rows` any mode describes, laid out per player instead of per statistic,
// and the `custom` payload x01 sends for its own use — recent visit scores, drawn as bars, which is
// the shape a table cannot express and the reason this file exists.
//
// **However many players there are.** The roster is read off the rows rather than assumed, one card
// is drawn per player, and the cards wrap — so a five-handed match is more of the same rather than a
// second layout. `leads` compares a player against every other one, not against an opponent.

/** The headline number on each card. The rest of the rows are listed underneath it. */
const HEADLINE = '3-dart average';

/**
 * Which way is better, per row.
 *
 * Fewer darts is a better leg and more of them is a worse one, so "highest wins" would praise the
 * wrong player. Knowing that is exactly the sort of thing a mode's own component is for; a row not
 * listed here is simply never highlighted.
 */
const BETTER: Record<string, 'higher' | 'lower'> = {
  '3-dart average': 'higher',
  'Scoring average': 'higher',
  '180s': 'higher',
  'Legs won': 'higher',
  'Darts this leg': 'lower',
  'Best leg (darts)': 'lower',
};

interface Recent {
  recent: Record<string, number[]>;
  max: number;
}

export default function X01Panel({ panel }: ModePanelProps) {
  const playerIds = [...new Set(panel.rows.flatMap((row) => Object.keys(row.values)))];
  const { recent, max } = (panel.custom ?? { recent: {}, max: 180 }) as Recent;

  const headline = panel.rows.find((row) => row.label === HEADLINE);
  const rest = panel.rows.filter((row) => row.label !== HEADLINE);

  return (
    // Cards share whatever the column gives them and wrap only when even that is too little, so the
    // panel reads the same in a narrow side column as it does across a phone.
    <div className="flex flex-wrap justify-center gap-3 w-full">
      {playerIds.map((playerId) => (
        <div key={playerId} className="bg-gray-900 rounded-lg px-4 py-2 flex-1 min-w-[8rem] max-w-[16rem] flex flex-col gap-2">
          {headline && (
            <div className="text-center">
              <p className={`text-2xl font-bold font-mono ${leads(headline, playerId, playerIds) ? 'text-green-400' : 'text-gray-300'}`}>
                {textOf(headline.values[playerId])}
              </p>
              <p className="text-[10px] uppercase text-gray-500">{headline.label}</p>
            </div>
          )}

          <Bars scores={recent[playerId] ?? []} max={max} />

          <dl className="text-xs">
            {rest.map((row) => (
              <div key={row.label} className="flex justify-between gap-3 py-0.5">
                <dt className="text-gray-500">{row.label}</dt>
                <dd className={`font-mono ${leads(row, playerId, playerIds) ? 'text-green-400' : 'text-gray-300'}`}>
                  {textOf(row.values[playerId])}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/**
 * The last few visits as bars, tallest at a maximum.
 *
 * Empty slots are kept so the row keeps its width as a leg fills up, rather than growing under the
 * player's eye.
 */
function Bars({ scores, max }: { scores: number[]; max: number }) {
  const slots = [...Array(6)].map((_, i) => scores[scores.length - 6 + i]);

  return (
    <div className="flex items-end gap-1 h-8" aria-hidden>
      {slots.map((score, i) => (
        <div key={i} className="flex-1 bg-gray-800 rounded-sm h-full flex items-end">
          {score !== undefined && (
            <div
              className={`w-full rounded-sm ${score >= 100 ? 'bg-green-500' : score > 0 ? 'bg-green-800' : 'bg-red-900'}`}
              style={{ height: `${Math.max(6, (Math.min(score, max) / max) * 100)}%` }}
              title={String(score)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Whether this player has the best of a row, so the eye can find it. A tie leads nothing. */
function leads(row: ModePanel['rows'][number], playerId: string, playerIds: string[]): boolean {
  const direction = BETTER[row.label];
  if (!direction) return false;

  const value = Number(textOf(row.values[playerId]));
  if (!Number.isFinite(value)) return false;

  const others = playerIds
    .filter((id) => id !== playerId)
    .map((id) => Number(textOf(row.values[id])))
    .filter(Number.isFinite);

  if (others.length === 0) return false;
  return direction === 'higher'
    ? others.every((other) => value > other)
    : others.every((other) => value < other);
}
