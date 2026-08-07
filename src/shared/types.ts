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

export type { ModeSettings } from './modes/catalog';
import type { ModeSettings } from './modes/catalog';

/**
 * Match-level settings. Only `mode` is universal; everything the mode itself needs lives under
 * `modeSettings`, declared by the mode in shared/modes/catalog.ts. Match format (first to n legs,
 * first to m sets) will sit next to `mode`, never inside `modeSettings`.
 */
export interface MatchSettings {
  mode: string;
  modeSettings: ModeSettings;
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
  /** Optional payload for the mode's own screen element. Absent → nothing is rendered there. */
  panel?: unknown;
}

// --- Match state ---

export type MatchStatus = 'in_progress' | 'finished';

export interface MatchState {
  id: string;
  status: MatchStatus;
  settings: MatchSettings;
  players: Player[];
  visits: Visit[];
  currentPlayerIndex: number;
  /** Null on a finished match means it was cancelled rather than won. */
  winnerId: string | null;
  createdAt: number;
  finishedAt: number | null;
  isLocal: boolean;
  currentVisit?: CurrentVisit;
  /**
   * Participants who have left. Leaving is final: they cannot rejoin, and a match anybody has left
   * offers no re-match, because the person who would have to agree to it is gone.
   */
  departed: string[];
  /** Players who have accepted a re-match. All of them accepting starts one. */
  rematchVotes: string[];
}

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
}
