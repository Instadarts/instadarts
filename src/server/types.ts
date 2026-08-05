export interface Client {
  sessionId: string;
  lobbyId: string | null;
  gameId: string | null;
  playerId: string | null;
  isSpectator: boolean;
}
