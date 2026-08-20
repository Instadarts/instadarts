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
 * One of the media features a game mode may decline. The names are the glossary's own.
 *
 * A ban is about a feature and not about media as a whole: a mode that wants no video still joins
 * the mesh, still gets a roster, and would still be handed anything added later. See `bansMedia`.
 */
export type MediaFeature = 'boardVideo' | 'dartEvidence';

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
  /** Media features this mode does not want. Anything not named stays available. */
  bansMedia: readonly MediaFeature[];
  /**
   * The most players this mode's rules will take, or null if it imposes no limit of its own.
   */
  maxPlayers: number | null;
}

/**
 * Whether a mode declined a feature.
 *
 * Fails open, and deliberately: a descriptor that has not arrived yet, or a mode this build does not
 * have, is not an instruction to withhold anything. Both sides of the wire ask through here so that
 * "does this mode want video" cannot be answered two different ways.
 */
export function modeBans(descriptor: ModeDescriptor | undefined, feature: MediaFeature): boolean {
  return descriptor?.bansMedia?.includes(feature) ?? false;
}

/** The cap a lobby enforces: the deployment's, narrowed by the mode's. Fails open on silence. */
export function effectiveMaxPlayers(serverMax: number, modeMax: number | null | undefined): number {
  return modeMax == null ? serverMax : Math.min(serverMax, modeMax);
}
