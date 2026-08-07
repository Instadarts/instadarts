import type { MatchSettings } from '../../shared/types';
import type { SettingsValue } from '../../shared/settings';
import { describeMode } from '../../shared/modes/catalog';
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
  canEdit: boolean;
  onChange: (patch: SettingsPatch) => void;
}

/**
 * Everything the lobby configures: the shape of the match, then the rules of the game mode.
 *
 * Two blocks because they belong to two layers — the format means the same thing whatever mode is
 * played, and the mode's settings mean nothing outside it. Both are rendered from their own
 * declarations, so neither block names a setting.
 */
export function MatchSettingsPanel({ settings, canEdit, onChange }: MatchSettingsPanelProps) {
  const descriptor = describeMode(settings.mode);

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
      />
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
