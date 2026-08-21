import type { Lobby } from '../../shared/types';
import type { ModeDescriptor } from '../../shared/settings';
import { PlayerList } from '../components/PlayerList';
import { MatchSettingsPanel } from '../components/MatchSettingsPanel';
import { InvitePanel } from '../components/InvitePanel';

interface LobbyPageProps {
  lobby: Lobby;
  modes: ModeDescriptor[];
  mode: 'local' | 'online';
  isCreator: boolean;
  ownPlayerIds: string[];
  isSpectator: boolean;
  onStartGame: () => void;
  onLeave: () => void;
  onUpdateSettings: (settings: any) => void;
  onAddLocalPlayer: (name: string) => void;
  onRemovePlayer: (playerId: string) => void;
  onReorderPlayer?: (playerId: string, direction: 'up' | 'down') => void;
}

export function LobbyPage({
  lobby,
  modes,
  mode,
  isCreator,
  ownPlayerIds,
  isSpectator,
  onStartGame,
  onLeave,
  onUpdateSettings,
  onAddLocalPlayer,
  onRemovePlayer,
  onReorderPlayer,
}: LobbyPageProps) {
  // One player is enough for any lobby: a match of one is a practice session.
  const canStart = lobby.players.length >= 1;
  const canEdit = !isSpectator && isCreator;

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4">
      <h2 className="text-3xl font-bold text-green-400 mb-2">
        {mode === 'local' ? 'Local Match' : 'Online Match'}
        {isSpectator && <span className="text-yellow-400 text-lg ml-2">(spectating)</span>}
      </h2>
      <p className="text-gray-500 text-sm mb-6">
        {mode === 'local'
          ? 'Add players and configure the match'
          : 'Share the code below and wait for players to connect'}
      </p>

      <PlayerList
        players={lobby.players}
        maxPlayers={lobby.maxPlayers}
        isCreator={isCreator}
        isSpectator={isSpectator}
        ownPlayerIds={ownPlayerIds}
        onAdd={onAddLocalPlayer}
        onRemove={onRemovePlayer}
        onReorder={onReorderPlayer}
      />

      <MatchSettingsPanel
        settings={lobby.settings}
        modes={modes}
        canEdit={canEdit}
        onChange={onUpdateSettings}
      />

      {isCreator && mode === 'online' && (
        <InvitePanel
          inviteCode={lobby.inviteCode}
          userCount={lobby.userCount}
          maxPlayers={lobby.maxPlayers}
          /* The server's answer, not our re-derivation of its rule — see `joinRefusal`. */
          isClosed={!lobby.admitting}
        />
      )}

      {mode === 'online' && !isSpectator && (ownPlayerIds.length === 0 || lobby.userCount === 1) && (
        <p className="text-yellow-400 text-sm mb-6">
          {ownPlayerIds.length === 0
            ? 'Add yourself as a player to get started'
            /* Keyed on users rather than players: a lobby of one player is startable now, so the
               only thing still worth waiting for is somebody else turning up. */
            : 'Waiting for players to join...'}
        </p>
      )}

      <div className="flex gap-2">
        {!isSpectator && isCreator && (
          <button
            onClick={onStartGame}
            disabled={!canStart}
            className="px-6 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 rounded-lg font-semibold transition-colors"
          >
            Start Match
          </button>
        )}
        <button
          onClick={onLeave}
          className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
        >
          Leave
        </button>
      </div>
    </div>
  );
}
