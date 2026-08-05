import { getAllGames, getAllLobbies } from './store';

const MAX_LOBBIES = 100;
const MAX_GAMES = 100;

export function canCreateLobby(): boolean {
  return getAllLobbies().size < MAX_LOBBIES;
}

export function canCreateGame(): boolean {
  return getAllGames().size < MAX_GAMES;
}
