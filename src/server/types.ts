export interface Client {
  lobbyId: string | null;
  gameId: string | null;
  playerId: string | null;
  isHost: boolean;
  isSpectator: boolean;
}
