import { randomInt } from 'node:crypto';
import { findLobbyByInviteCode, getLobby, setLobbyInviteCode } from './store';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const CODE_LENGTH = 6;

/**
 * Attach a cryptographically random 6-character code that no existing lobby holds.
 * Rotation also excludes this lobby's current code so the previous invite is retired.
 */
export function generateInviteCode(lobbyId: string): string | null {
  if (!getLobby(lobbyId)) return null;

  let code = '';
  do {
    code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  } while (findLobbyByInviteCode(code));

  // Checking and assignment are synchronous, so another invite cannot claim the code in between.
  const success = setLobbyInviteCode(lobbyId, code);
  return success ? code : null;
}
