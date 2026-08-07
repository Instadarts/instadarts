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
 * The rows are data the mode described, rendered here without the screen knowing what any of them
 * mean — one row per statistic, one column per player. A mode that also ships a component gets it
 * rendered underneath, fed whatever it put in `custom`.
 */
export function ModePanelBlock({ modeId, panel }: ModePanelBlockProps) {
  const Custom = MODE_PANELS[modeId];
  const playerIds = [...new Set(panel.rows.flatMap((row) => Object.keys(row.values)))];

  if (panel.rows.length === 0 && panel.custom === undefined) return null;

  return (
    <div className="flex flex-col items-center gap-2">
      {panel.title && <h3 className="text-gray-400 text-sm uppercase">{panel.title}</h3>}

      {panel.rows.length > 0 && (
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

      {Custom && panel.custom !== undefined && <Custom payload={panel.custom} />}
    </div>
  );
}
