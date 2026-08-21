import type { ReactNode } from 'react';
import type { SettingsField, SettingsValue } from '../../shared/settings';

interface SettingsFieldsProps {
  title: string;
  fields: SettingsField[];
  values: Record<string, SettingsValue | undefined>;
  canEdit: boolean;
  onChange: (key: string, value: SettingsValue) => void;
  /** Anything that belongs in this block but is not a declared field — the mode selector. */
  children?: ReactNode;
}

/**
 * A block of settings, rendered from what they declare about themselves.
 *
 * Deliberately knows no setting by name — it is used for the match format and for whichever game
 * mode is selected, and neither of them needs anything here to change.
 */
export function SettingsFields({ title, fields, values, canEdit, onChange, children }: SettingsFieldsProps) {
  return (
    <div className="w-full">
      <h3 className="text-gray-400 text-sm uppercase mb-2">
        {title}
        {!canEdit && <span className="text-gray-600 ml-1">(read-only)</span>}
      </h3>
      <div className="space-y-3 bg-gray-900 rounded-lg p-4">
        {children}
        {fields.map((field) => (
          <Field
            key={field.key}
            field={field}
            value={values[field.key]}
            canEdit={canEdit}
            onChange={(value) => onChange(field.key, value)}
          />
        ))}
      </div>
    </div>
  );
}

interface FieldProps {
  field: SettingsField;
  value: SettingsValue | undefined;
  canEdit: boolean;
  onChange: (value: SettingsValue) => void;
}

/** Every control in this block looks the same; only what it edits differs. */
const SELECT = 'w-full mt-1 px-3 py-1 bg-gray-800 border border-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed';

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

  if (field.kind === 'select') {
    return (
      <div>
        <label className="text-gray-400 text-sm">{field.label}</label>
        <select
          value={typeof value === 'string' ? value : field.options[0].value}
          onChange={(e) => onChange(e.target.value)}
          disabled={!canEdit}
          aria-label={field.label}
          className={SELECT}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
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
          aria-label={field.label}
          className={SELECT}
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
          aria-label={field.label}
          className={SELECT}
        />
      )}
    </div>
  );
}
