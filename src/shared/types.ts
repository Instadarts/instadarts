// --- Scoring ---

export interface ScoreResult {
  label: string;
  points: number;
  mult: number;
  base: number;
}

// --- Game entities ---

export interface Player {
  id: string;
  name: string;
  isRemote: boolean;
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
  bust: boolean;
}

// --- Game configuration ---

export type GameMode = 'x01';

export interface GameSettings {
  mode: GameMode;
  doubleIn: boolean;
  doubleOut: boolean;
  startScore: number;
}

// --- Game state ---

export type GameStatus = 'lobby' | 'in_progress' | 'finished';

export interface GameState {
  id: string;
  status: GameStatus;
  settings: GameSettings;
  players: Player[];
  visits: Visit[];
  currentPlayerIndex: number;
  winnerId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

// --- Lobby ---

export interface Lobby {
  id: string;
  players: Player[];
  settings: GameSettings;
  inviteCode: string | null;
  hostPlayerId: string | null;
  isLocal: boolean;
  createdAt: number;
}
