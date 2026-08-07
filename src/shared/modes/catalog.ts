// What each game mode calls its settings.
//
// A mode declares its own settings here — the fields, their bounds and their defaults — and both
// sides use that one declaration: the lobby renders the fields generically, and the server validates
// incoming values against the same list. Neither side names an x01 setting anywhere.
//
// Shared rather than server-only because the lobby has to render a panel before a match exists, and
// a settings *descriptor* is configuration, not a rule. The rules stay in src/server/modes/.

/** A mode's own settings. Values are validated against the field list below before they are stored. */
export type ModeSettings = Record<string, string | number | boolean>;

export type SettingsField =
  | { key: string; label: string; kind: 'toggle' }
  | {
      key: string;
      label: string;
      kind: 'number';
      min: number;
      max: number;
      /** Usual values, offered as a dropdown. Suggestions — anything in range is still accepted. */
      options?: { value: number; label: string }[];
    };

export interface ModeDescriptor {
  id: string;
  /** Shown in the lobby. */
  label: string;
  defaults: ModeSettings;
  fields: SettingsField[];
}

export const MODE_CATALOG: Record<string, ModeDescriptor> = {
  x01: {
    id: 'x01',
    label: 'x01',
    defaults: { startScore: 501, doubleIn: false, doubleOut: true },
    fields: [
      {
        key: 'startScore',
        label: 'Starting Score',
        kind: 'number',
        min: 101,
        max: 999,
        options: [
          { value: 301, label: '301' },
          { value: 501, label: '501' },
          { value: 701, label: '701' },
        ],
      },
      { key: 'doubleIn', label: 'Double In', kind: 'toggle' },
      { key: 'doubleOut', label: 'Double Out', kind: 'toggle' },
    ],
  },
};

export const DEFAULT_MODE = 'x01';

export function describeMode(id: string): ModeDescriptor | undefined {
  return MODE_CATALOG[id];
}

/** A fresh settings object for a mode, or undefined if there is no such mode. */
export function defaultSettingsFor(id: string): ModeSettings | undefined {
  const descriptor = describeMode(id);
  return descriptor ? { ...descriptor.defaults } : undefined;
}
