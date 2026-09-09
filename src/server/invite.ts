import { randomInt } from 'node:crypto';
import { findLobbyByInviteCode, getLobby, setLobbyInviteCode } from './store';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const CODE_LENGTH = 6;

/** Personal admission credentials never travel in room snapshots. */
const personalInvites = new Map<string, { lobbyId: string; playerId: string }>();

export function findPersonalInvite(code: unknown): { lobbyId: string; playerId: string } | undefined {
  return typeof code === 'string' ? personalInvites.get(code) : undefined;
}

export function retirePersonalInvites(lobbyId: string): void {
  for (const [code, invite] of personalInvites) {
    if (invite.lobbyId === lobbyId) personalInvites.delete(code);
  }
}

function unusedCode(): string {
  let code: string;
  do {
    code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  } while (findLobbyByInviteCode(code) || personalInvites.has(code));
  return code;
}

export function generatePersonalInvite(lobbyId: string, playerId: string): string {
  const code = unusedCode();
  personalInvites.set(code, { lobbyId, playerId });
  return code;
}

/**
 * Attach a cryptographically random 6-character code that no existing lobby holds.
 * Rotation also excludes this lobby's current code so the previous invite is retired.
 */
export function generateInviteCode(lobbyId: string): string | null {
  if (!getLobby(lobbyId)) return null;

  const code = unusedCode();

  // Checking and assignment are synchronous, so another invite cannot claim the code in between.
  const success = setLobbyInviteCode(lobbyId, code);
  return success ? code : null;
}
