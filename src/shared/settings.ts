// How a setting declares itself.
//
// One declaration serves both sides: the lobby renders the field, and the server validates values
// against the same bounds. Used for match-level settings and for each game mode's own — neither the
// panel nor the validator ever names a setting.

export type SettingsValue = string | number | boolean;

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

/** A mode's own settings. Validated against the mode's declared fields before they are stored. */
export type ModeSettings = Record<string, SettingsValue>;

/**
 * What a game mode says about itself, so the lobby can offer it without importing a line of its
 * code. Declared by the mode and shipped to the client on connect.
 */
export interface ModeDescriptor {
  id: string;
  /** Shown in the lobby's mode selector. */
  label: string;
  defaults: ModeSettings;
  fields: SettingsField[];
}
