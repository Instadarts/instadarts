import { getAllMatches, getAllLobbies } from './store';

const MAX_LOBBIES = 100;
const MAX_MATCHES = 100;

export function canCreateLobby(): boolean {
  return getAllLobbies().size < MAX_LOBBIES;
}

export function canCreateMatch(): boolean {
  return getAllMatches().size < MAX_MATCHES;
}
