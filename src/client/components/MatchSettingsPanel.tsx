import type { MatchSettings } from '../../shared/types';
import type { ModeDescriptor, SettingsValue } from '../../shared/settings';
import { MATCH_FIELDS } from '../../shared/matchFormat';
import { SettingsFields } from './SettingsFields';

/**
 * One field's new value, and nothing else.
 *
 * Deliberately a patch rather than the whole settings object: the server merges it over what it
 * already has, so two edits in quick succession cannot overwrite each other with a value that was
 * stale by the time the second one was sent.
 */
export interface SettingsPatch {
  mode?: string;
  modeSettings?: Record<string, SettingsValue>;
  legsToWinSet?: number;
  setsToWinMatch?: number;
}

interface MatchSettingsPanelProps {
  settings: MatchSettings;
  /** The modes this deployment has, as the server described them on connect. */
  modes: ModeDescriptor[];
  canEdit: boolean;
  onChange: (patch: SettingsPatch) => void;
}

/**
 * Everything the lobby configures: the shape of the match, then the game and its rules.
 *
 * Nothing here is imported from a game mode — the mode list, its label and its settings all arrive
 * from the server, so installing a mode is a server-side act and this file never changes.
 */
export function MatchSettingsPanel({ settings, modes, canEdit, onChange }: MatchSettingsPanelProps) {
  const descriptor = modes.find((m) => m.id === settings.mode);

  const setFormat = (key: string, value: SettingsValue) => onChange({ [key]: value });
  const setMode = (key: string, value: SettingsValue) => onChange({ modeSettings: { [key]: value } });

  return (
    <>
      <SettingsFields
        title="Match"
        fields={MATCH_FIELDS}
        values={{ setsToWinMatch: settings.setsToWinMatch, legsToWinSet: settings.legsToWinSet }}
        canEdit={canEdit}
        onChange={setFormat}
      >
        <div>
          <label className="text-gray-400 text-sm" htmlFor="game-mode">Game</label>
          <select
            id="game-mode"
            aria-label="Game"
            value={settings.mode}
            onChange={(e) => onChange({ mode: e.target.value })}
            disabled={!canEdit || modes.length === 0}
            className="w-full mt-1 px-3 py-1 bg-gray-800 border border-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {modes.map((mode) => (
              <option key={mode.id} value={mode.id}>{mode.label}</option>
            ))}
          </select>
        </div>
      </SettingsFields>

      {descriptor && (
        <SettingsFields
          title={`${descriptor.label} settings`}
          fields={descriptor.fields}
          values={settings.modeSettings}
          canEdit={canEdit}
          onChange={setMode}
        />
      )}
    </>
  );
}
