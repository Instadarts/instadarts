// The game mode contract.
//
// A mode owns how a **leg** is played and won, and — separately — a block of the match screen it may
// draw on. Its rules do not know that matches, sets, sockets, lobbies or spectators exist:
// everything they may look at is in LegContext.
//
// See docs/game-modes.md for the reasoning; the rules that shape this file are:
//
//   · **A leg always ends with a winner.** `finalizeVisit` reports one, and match logic (first to n
//     legs, first to m sets) is built on that guarantee holding for every mode.
//   · **A mode holds no state.** Everything is derived from the visit history and the visit in
//     progress, which is what makes undo, reconnect and a fresh leg free.
//   · **A mode is one file.** Its rules, its settings and its panel are declared together in
//     src/server/modes/<id>.ts. The inventory of them is explicit and lives in registry.ts — a mode
//     is installed by writing the file and adding one import there.

import type { CurrentVisit, MatchState, ModePanel, ModeView, Player, Visit } from '../../shared/types';
import type { MediaFeature, ModeDescriptor, ModeSettings, SettingsField } from '../../shared/settings';

/**
 * One leg, as the mode's rules see it. Deliberately no match, no set, no leg number and no ids
 * beyond the players: rules that cannot see the match structure cannot come to depend on it.
 */
export interface LegContext {
  /** This mode's own settings, already validated against its declared fields. */
  settings: ModeSettings;
  players: Player[];
  /** Whose visit it is. The match layer decides this; the mode only reads it. */
  currentPlayerId: string;
  /** Committed visits of this leg, in order. */
  visits: Visit[];
  currentVisit?: CurrentVisit;
}

export interface FinalizedVisit {
  /** The visit to append. The mode decides padding and whether it is void. */
  visit: Visit;
  /** Set iff this visit won the leg. */
  legWinnerId: string | null;
}

export interface GameMode {
  readonly id: string;
  /** Shown in the lobby's mode selector. */
  readonly label: string;
  /** This mode's settings: their defaults, and how to render and validate them. */
  readonly defaults: ModeSettings;
  readonly fields: SettingsField[];

  /**
   * Media features this mode does not want. Anything not named stays available, so leaving this out
   * is the ordinary case and means a mode plays with everything the deployment offers.
   *
   * Declared here and read elsewhere, like `fields`: naming a feature is not knowing that peers or
   * sockets exist. Nor is it a way to turn media off — a mode that banned both would still join the
   * mesh and still be handed whatever is added to it later. It withholds a feature, no more.
   */
  readonly bansMedia?: readonly MediaFeature[];

  /**
   * The most players this mode's rules will take, or omitted for no limit of its own. The
   * deployment's own cap still applies and is the smaller of the two.
   */
  readonly maxPlayers?: number;

  /** How many darts a visit may hold. Read by the match layer and by the match screen. */
  dartsPerVisit(settings: ModeSettings): number;

  /**
   * May the visit in progress take another dart? Evaluated after each dart is appended, and again
   * after an undo.
   *
   * Locked is not ended: the visit stays open until it is submitted, which is the window in which a
   * misread dart gets corrected.
   */
  isVisitLocked(ctx: LegContext): boolean;

  /** Finalize the visit in progress into one to commit, and say whether it won the leg. */
  finalizeVisit(ctx: LegContext): FinalizedVisit;

  /**
   * Everything mode-specific the match screen shows **for the current leg**. Computed here rather
   * than in the browser so that the client holds no rules.
   */
  view(ctx: LegContext): ModeView;

  /**
   * The mode's own block on the match screen, across the **whole match**.
   *
   * Handed the match itself — every leg played, the one in progress, the settings — because a
   * statistic is about the match, not about a leg. It is safe to show it everything precisely
   * because it can only return something to draw: nothing it returns here reaches the rules.
   *
   * Omitted, or returning undefined, means the mode draws nothing.
   */
  panel?(match: MatchState): ModePanel | undefined;
}

/**
 * What the lobby needs to offer a mode, without importing any of its code.
 *
 * `bansMedia` is optional to declare and always present to read: a mode that says nothing describes
 * itself as banning nothing, so no consumer has to tell "declined none" from "did not say".
 */
export function describeMode(mode: GameMode): ModeDescriptor {
  return {
    id: mode.id,
    label: mode.label,
    defaults: { ...mode.defaults },
    fields: mode.fields,
    bansMedia: [...(mode.bansMedia ?? [])],
    maxPlayers: mode.maxPlayers ?? null,
  };
}

// ============================================================
// The registry
// ============================================================

const modes = new Map<string, GameMode>();

export function registerMode(mode: GameMode): void {
  modes.set(mode.id, mode);
}

export function getMode(id: string): GameMode | undefined {
  return modes.get(id);
}

/** Every installed mode, in a stable order, for the lobby to choose from. */
export function allModes(): GameMode[] {
  return [...modes.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The mode a new lobby starts on. Mandatory: a deployment without x01 is not a valid deployment, and
 * `loadModes` refuses to start one.
 */
export const DEFAULT_MODE = 'x01';

/**
 * Validate that every mode self-registered at import time (each file calls registerMode at the top
 * level, and registry.ts imports them all).  The server refuses to start without x01.
 */
export async function loadModes(): Promise<GameMode[]> {
  if (!getMode(DEFAULT_MODE)) {
    throw new Error(`The ${DEFAULT_MODE} game mode is required — add it to registry.ts`);
  }
  return allModes();
}
