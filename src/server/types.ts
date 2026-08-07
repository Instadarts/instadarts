export interface Client {
  sessionId: string;
  lobbyId: string | null;
  matchId: string | null;
  playerId: string | null;
  isSpectator: boolean;
  /**
   * Set once this connection has identified itself as a scoring device. A connection is either a
   * frontend or a scoring device, never both, and this is what tells them apart.
   */
  deviceId: string | null;
}
