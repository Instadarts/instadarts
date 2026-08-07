import type { Lobby } from '../../shared/types';
import { PlayerList } from '../components/PlayerList';
import { ModeSettingsPanel } from '../components/ModeSettingsPanel';
import { InvitePanel } from '../components/InvitePanel';

interface LobbyPageProps {
  lobby: Lobby;
  mode: 'local' | 'online';
  isCreator: boolean;
  ownPlayerId: string | null;
  isSpectator: boolean;
  sessionId: string | null;
  onStartGame: () => void;
  onLeave: () => void;
  onUpdateSettings: (settings: any) => void;
  onAddLocalPlayer: (name: string) => void;
  onRemovePlayer: (playerId: string) => void;
  onSwapPlayers: () => void;
}

export function LobbyPage({
  lobby,
  mode,
  isCreator,
  ownPlayerId,
  isSpectator,
  sessionId,
  onStartGame,
  onLeave,
  onUpdateSettings,
  onAddLocalPlayer,
  onRemovePlayer,
  onSwapPlayers,
}: LobbyPageProps) {
  const canStart =
    mode === 'local'
      ? lobby.players.length >= 1
      : lobby.players.length === 2;
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
          : 'Share the code below and wait for your opponent to connect'}
      </p>

      <PlayerList
        players={lobby.players}
        mode={mode}
        isCreator={isCreator}
        isSpectator={isSpectator}
        sessionId={sessionId}
        onAdd={onAddLocalPlayer}
        onRemove={onRemovePlayer}
        onSwap={onSwapPlayers}
      />

      <ModeSettingsPanel
        settings={lobby.settings}
        canEdit={canEdit}
        onChange={onUpdateSettings}
      />

      {isCreator && mode === 'online' && (
        <InvitePanel
          inviteCode={lobby.inviteCode}
          remoteConnected={lobby.remoteConnected}
        />
      )}

      {mode === 'online' && !isSpectator && lobby.players.length < 2 && (
        <p className="text-yellow-400 text-sm mb-6">
          {!ownPlayerId
            ? 'Add yourself as a player to get started'
            : 'Waiting for opponent to join...'}
        </p>
      )}

      <div className="flex gap-4">
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
