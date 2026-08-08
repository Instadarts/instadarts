// --- Scoring ---

export interface ScoreResult {
  label: string;
  points: number;
  mult: number;
  base: number;
}

// --- Match entities ---

export interface Player {
  id: string;
  name: string;
  /** The user (frontend connection) that added this player. Both players share one in a local match. */
  sessionId: string;
}

export interface DartThrow {
  x: number;
  y: number;
  score: ScoreResult;
}

export interface Visit {
  darts: DartThrow[];
  playerId: string;
  visitNumber: number;
  /** This visit scored nothing. The game mode decides when — x01 calls it a bust. */
  voided: boolean;
}

export interface CurrentVisit {
  playerId: string;
  darts: DartThrow[];
  locked: boolean;
}

// --- Match configuration ---

export type { ModeSettings } from './settings';
import type { ModeSettings } from './settings';

/**
 * Match-level settings. The format and the mode are universal; everything the mode itself needs
 * lives under `modeSettings`, declared by the mode itself.
 *
 * Both counts have a minimum — and a default — of 1, so "first to 1 set, first to 1 leg" is a single
 * play-through and needs no special case anywhere.
 */
export interface MatchSettings {
  mode: string;
  modeSettings: ModeSettings;
  /** Legs a player must win to take a set. */
  legsToWinSet: number;
  /** Sets a player must win to take the match. */
  setsToWinMatch: number;
}

// --- What the game mode contributes to the match screen ---

/**
 * How a piece of a mode's text should read.
 *
 * Deliberately semantic, not CSS: a mode says *what it means*, and the screen decides what that
 * looks like in the element it lands in. `danger` is a red word in the history and a red-backed slot
 * on the board, and a redesign changes both in one place. Raw colours would also not survive the
 * wire — the whole view is JSON.
 */
export type TextTone = 'default' | 'muted' | 'accent' | 'positive' | 'warning' | 'danger';
export type TextSize = 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';
export type TextWeight = 'normal' | 'medium' | 'semibold' | 'bold';

export interface TextStyle {
  tone?: TextTone;
  size?: TextSize;
  weight?: TextWeight;
}

export interface StyledText extends TextStyle {
  text: string;
}

/**
 * Any text a mode supplies. A bare string takes the element's own defaults — which is what a mode
 * should send unless it has a reason not to, because those defaults are what makes the screen look
 * like one screen. Every hint is an override of exactly one axis; the rest still come from the
 * element.
 */
export type ViewText = string | StyledText;

/** The text of a `ViewText`, whichever form it came in. */
export function textOf(value: ViewText | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : value.text;
}

/** The style hints of a `ViewText`, or none for a bare string. */
export function styleOf(value: ViewText | undefined): TextStyle {
  return value === undefined || typeof value === 'string' ? {} : value;
}

/**
 * Everything mode-specific the match screen displays, computed by the mode on the server and shipped
 * with the match state. The screen holds no rules: it renders these values and nothing else knows
 * what they mean.
 *
 * See docs/game-modes.md for which screen element each field feeds.
 */
export interface ModeView {
  /** Headline text. x01: "501 — Double Out". */
  headline: ViewText;
  /** Optional line under the headline. x01 uses it for the double-in prompt. */
  notice?: ViewText;
  /**
   * Player card score, by player id. Text, not a number: it is what lets x01 put "Bust!" where a
   * score goes without the screen knowing what a bust is.
   */
  playerScores: Record<string, ViewText>;
  /** The `Visit: <total>` line. Empty text hides the line entirely. */
  visitTotal: ViewText;
  dartsPerVisit: number;
  /** Optional dart slot contents. Omitted → the screen renders each dart's own label. */
  slots?: ViewText[];
  /** Visit history, newest first, one entry per committed visit. */
  history: ViewText[];
}

// --- Match state ---

export type MatchStatus = 'in_progress' | 'finished';

/** A leg that has been played out. The ordered list of these is what standings are derived from. */
export interface CompletedLeg {
  visits: Visit[];
  winnerId: string;
}

export interface MatchState {
  id: string;
  status: MatchStatus;
  settings: MatchSettings;
  players: Player[];
  /** The **current leg's** visits. Finished legs are in `legs`. */
  visits: Visit[];
  /** Every finished leg, in order. See shared/matchFormat.ts — standings are derived from it. */
  legs: CompletedLeg[];
  currentPlayerIndex: number;
  /** Null on a finished match means it was cancelled rather than won. */
  winnerId: string | null;
  createdAt: number;
  finishedAt: number | null;
  isLocal: boolean;
  currentVisit?: CurrentVisit;
  /**
   * Participants who have left. Leaving is final: they cannot rejoin, and it counts as declining a
   * re-match, so a match anybody has left can never start one.
   */
  departed: string[];
  /**
   * Each player's answer to a re-match. A player with no entry has not answered yet. Everyone
   * accepting starts one; a single decline settles it for good.
   */
  rematchVotes: Record<string, RematchAnswer>;
  /**
   * When this match dies unless something happens first.
   *
   * While it is being played, that is the idle timeout: any input pushes it back. Once it is over,
   * it is the summary deadline — at which point unanswered re-match votes become declines and the
   * match is torn down, so no match can linger on the server without an end.
   */
  expiresAt: number;
}

export type RematchAnswer = 'accepted' | 'declined';

// --- Lobby ---

export interface Lobby {
  id: string;
  players: Player[];
  settings: MatchSettings;
  inviteCode: string | null;
  hostPlayerId: string | null;
  hostSessionId: string | null;
  isLocal: boolean;
  remoteConnected: boolean;
  createdAt: number;
  /** When this lobby is abandoned unless something happens first. Any input pushes it back. */
  expiresAt: number;
}

// --- What a game mode contributes to the match screen, beyond one leg ---

/**
 * A mode's own block on the match screen — its vehicle for extending the match UI.
 *
 * Owned by the **match**, not by a leg: the mode is handed the whole match to build it, and can only
 * ever return something to draw. That is what makes it safe to show it everything — nothing it
 * returns here can affect how a leg is played.
 *
 * Declarative, so a mode needs no code in the client. A mode that genuinely must draw something this
 * cannot express puts a payload in `custom` and ships a component for it.
 */
export interface ModePanel {
  title?: string;
  /** Facts about the match or the leg rather than about a player — a round number, a phase. */
  lines?: ViewText[];
  /** One row per statistic; one value per player id. */
  rows: { label: string; values: Record<string, ViewText> }[];
  /** For a mode that also ships a client component. Rendered below the rows. */
  custom?: unknown;
  /**
   * How the mode would like the body drawn.
   *
   * `auto` (the default) uses the mode's own component where the deployment has one, and the
   * generic table where it does not; `table` asks for the table either way. A preference and not an
   * instruction: the server half of a mode cannot see whether its client half is installed, so
   * `auto` can promise the component only where there is one to use.
   */
  render?: 'auto' | 'table';
}
