import type { MatchSettings } from '../../shared/types';
import { describeMode } from '../../shared/modes/catalog';
import type { SettingsField } from '../../shared/modes/catalog';

interface ModeSettingsPanelProps {
  settings: MatchSettings;
  canEdit: boolean;
  onChange: (settings: MatchSettings) => void;
}

/**
 * The game mode's settings, rendered from what the mode declares.
 *
 * Deliberately knows no setting by name: a mode adds a field to its descriptor and it appears here.
 */
export function ModeSettingsPanel({ settings, canEdit, onChange }: ModeSettingsPanelProps) {
  const descriptor = describeMode(settings.mode);
  if (!descriptor) return null;

  const set = (key: string, value: string | number | boolean) => {
    onChange({ ...settings, modeSettings: { ...settings.modeSettings, [key]: value } });
  };

  return (
    <div className="w-80 mb-6">
      <h3 className="text-gray-400 text-sm uppercase mb-2">
        Settings
        {!canEdit && <span className="text-gray-600 ml-1">(read-only)</span>}
      </h3>
      <div className="space-y-3 bg-gray-900 rounded-lg p-4">
        {descriptor.fields.map((field) => (
          <Field
            key={field.key}
            field={field}
            value={settings.modeSettings[field.key]}
            canEdit={canEdit}
            onChange={(value) => set(field.key, value)}
          />
        ))}
      </div>
    </div>
  );
}

interface FieldProps {
  field: SettingsField;
  value: string | number | boolean | undefined;
  canEdit: boolean;
  onChange: (value: string | number | boolean) => void;
}

function Field({ field, value, canEdit, onChange }: FieldProps) {
  if (field.kind === 'toggle') {
    return (
      <label className={`flex items-center gap-3 ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          disabled={!canEdit}
          className="w-4 h-4 accent-green-500 disabled:opacity-50"
        />
        <span className="text-gray-300">{field.label}</span>
      </label>
    );
  }

  const numeric = typeof value === 'number' ? value : field.min;

  return (
    <div>
      <label className="text-gray-400 text-sm">{field.label}</label>
      {field.options ? (
        <select
          value={numeric}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={!canEdit}
          className="w-full mt-1 px-3 py-1 bg-gray-800 border border-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : (
        <input
          type="number"
          value={numeric}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={!canEdit}
          className="w-full mt-1 px-3 py-1 bg-gray-800 border border-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
        />
      )}
    </div>
  );
}
