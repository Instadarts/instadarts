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
    }
  | {
      key: string;
      label: string;
      kind: 'select';
      /** The whole of what this setting may be. Unlike a number's options, nothing else is accepted. */
      options: { value: string; label: string }[];
    };

/** A mode's own settings. Validated against the mode's declared fields before they are stored. */
export type ModeSettings = Record<string, SettingsValue>;

/**
 * Reading a setting out of that bag.
 *
 * The bag is untyped because a mode declares its own keys, so every mode ends up writing the same
 * "is it the right type, and if not what do I do" line for each of its settings. These are that
 * line, once. The fallback is not a second copy of the default — it is what to do with a value that
 * should have been validated and was not, which happens whenever a settings object is built by
 * something other than a lobby (a test, a re-match of an older match, a mode that has since gained
 * a field).
 */
export function numberOr(settings: ModeSettings, key: string, fallback: number): number {
  const value = settings[key];
  return typeof value === 'number' ? value : fallback;
}

export function boolOr(settings: ModeSettings, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function stringOr(settings: ModeSettings, key: string, fallback: string): string {
  const value = settings[key];
  return typeof value === 'string' ? value : fallback;
}

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
