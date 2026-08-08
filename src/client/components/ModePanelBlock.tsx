import type { ModePanel } from '../../shared/types';
import { textOf } from '../../shared/types';
import { modeTextClasses } from './modeText';
import { MODE_PANELS } from '../modes/panels';

interface ModePanelBlockProps {
  modeId: string;
  panel: ModePanel;
}

/**
 * The game mode's own block of the match screen.
 *
 * The title and any leg-wide lines are the screen's to render, so every mode's block reads the same
 * way. The body is the mode's data: one row per statistic, one column per player, rendered here
 * without the screen knowing what any of them mean — unless the mode ships a component, which then
 * draws that same data itself.
 *
 * Which of the two is used is the mode's to say (`panel.render`) and the deployment's to make
 * possible: asking for the table always gets it, and asking for the component gets it only where
 * that file exists. Both draw the same rows, so neither answer can leave the block empty.
 */
export function ModePanelBlock({ modeId, panel }: ModePanelBlockProps) {
  const Custom = panel.render === 'table' ? undefined : MODE_PANELS[modeId];
  const playerIds = [...new Set(panel.rows.flatMap((row) => Object.keys(row.values)))];

  const empty = panel.rows.length === 0 && !panel.lines?.length && panel.custom === undefined;
  if (empty) return null;

  return (
    <div className="flex flex-col items-center gap-1 w-full">
      {panel.title && <h3 className="text-gray-400 text-sm uppercase">{panel.title}</h3>}

      {panel.lines?.map((line, i) => (
        <p key={i} className={modeTextClasses(line, { size: 'sm', tone: 'muted' })}>{textOf(line)}</p>
      ))}

      {Custom ? (
        <Custom panel={panel} />
      ) : panel.rows.length > 0 && (
        <table className="text-sm">
          <tbody>
            {panel.rows.map((row) => (
              <tr key={row.label}>
                <td className="text-left pr-6 py-1 text-gray-500">{row.label}</td>
                {playerIds.map((playerId) => (
                  <td
                    key={playerId}
                    className={modeTextClasses(row.values[playerId], { size: 'sm' }, 'px-3 py-1 text-center font-mono')}
                  >
                    {textOf(row.values[playerId])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
