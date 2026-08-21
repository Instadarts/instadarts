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
  const canStart =
    mode === 'local'
      ? lobby.players.length >= 1
      : lobby.players.length >= 2;
  const canEdit = !isSpectator && (mode === 'local' || isCreator);

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
        mode={mode}
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
          /* The server's own join rule, so the panel stops offering a code exactly when the server
             would start refusing it: a full roster, or a lobby already holding its user limit. */
          isClosed={lobby.players.length >= lobby.maxPlayers || lobby.userCount >= lobby.maxPlayers}
        />
      )}

      {mode === 'online' && !isSpectator && lobby.players.length < 2 && (
        <p className="text-yellow-400 text-sm mb-6">
          {ownPlayerIds.length === 0
            ? 'Add yourself as a player to get started'
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
