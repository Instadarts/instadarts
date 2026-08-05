import { setLobbyInviteCode } from './store';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const CODE_LENGTH = 6;

/**
 * Generate a 6-character invite code and attach it to a lobby.
 */
export function generateInviteCode(lobbyId: string): string | null {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }

  const success = setLobbyInviteCode(lobbyId, code);
  return success ? code : null;
}
