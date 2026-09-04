import type { MatchSettings } from '../../shared/types';
import type { ModeDescriptor, SettingsValue } from '../../shared/settings';
import { MATCH_FIELDS } from '../../shared/matchFormat';
import { SettingsFields } from './SettingsFields';
import { NativeSelect, Stack } from '@mantine/core';

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
  return (
    <Stack gap="xl">
      <MatchFormatFields settings={settings} modes={modes} canEdit={canEdit} onChange={onChange} />
      <ModeSettingsFields settings={settings} modes={modes} canEdit={canEdit} onChange={onChange} />
    </Stack>
  );
}

export function MatchFormatFields({ settings, modes, canEdit, onChange }: MatchSettingsPanelProps) {
  const setFormat = (key: string, value: SettingsValue) => onChange({ [key]: value });

  return (
    <SettingsFields
      fields={MATCH_FIELDS}
      values={{ setsToWinMatch: settings.setsToWinMatch, legsToWinSet: settings.legsToWinSet }}
      canEdit={canEdit}
      onChange={setFormat}
    >
      <NativeSelect
        id="game-mode"
        label="Game"
        aria-label="Game"
        value={settings.mode}
        onChange={(event) => onChange({ mode: event.currentTarget.value })}
        disabled={!canEdit || modes.length === 0}
        data={modes.map((mode) => ({ value: mode.id, label: mode.label }))}
      />
    </SettingsFields>
  );
}

export function ModeSettingsFields({ settings, modes, canEdit, onChange }: MatchSettingsPanelProps) {
  const descriptor = modes.find((mode) => mode.id === settings.mode);
  if (!descriptor) return null;
  const setMode = (key: string, value: SettingsValue) => onChange({ modeSettings: { [key]: value } });
  return (
    <SettingsFields
      fields={descriptor.fields}
      values={settings.modeSettings}
      canEdit={canEdit}
      onChange={setMode}
    />
  );
}
