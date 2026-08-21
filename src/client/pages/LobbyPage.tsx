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

/**
 * The columns the lobby's cards are dealt into, widest first.
 *
 * One column on a phone, which is the layout this screen has always had and the order the cards are
 * written in below: roster, match format, game-mode settings, and — in an online lobby — the invite
 * code. Two columns from `md`, three from `lg` — which is the width at which three of them fit at
 * the size they want, rather than the width at which three squeezed ones would technically fit.
 *
 * Placement is left to the grid rather than pinned per card, because the source order is already the
 * order every width wants. In three columns the three cards a lobby always has fill the first row
 * and the invite lands under the roster, which is where it belongs: both are about who is in the
 * lobby, and the settings beside them stay together.
 *
 * A column is capped at the `w-80` these cards have always been, and never narrower than `16rem`,
 * which is what a settings row needs before the layout should have dropped a column instead. The
 * tracks are centred, so a window wider than three of them leaves the margin outside rather than
 * stretching a name field across it.
 */
const LOBBY_COLUMNS =
  'grid w-full justify-center items-start gap-4 grid-cols-[minmax(0,20rem)] ' +
  'md:grid-cols-[repeat(2,minmax(16rem,20rem))] ' +
  'lg:grid-cols-[repeat(3,minmax(16rem,20rem))]';

/**
 * Everything a match needs before it starts, in three rows: what this lobby is, what it holds, and
 * what you do about it.
 *
 * Only the middle row rearranges itself, and it does so on width alone — see `LOBBY_COLUMNS`.
 *
 * From `lg` the screen is additionally exactly as tall as the window and never scrolls as a whole:
 * the cards scroll inside the middle row if they have to, so the headline stays at the top and Start
 * Match stays where you left it rather than being pushed off the bottom. That is pinned at `lg`
 * rather than at `md` because the thing it needs is height, and the widths between the two are
 * mostly phones on their side — a window 390px tall has no room to spare for a row that stays put,
 * and there the three rows simply stack and the page scrolls, as it always has.
 */
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
    <div className="flex-1 flex flex-col items-center justify-center gap-6 p-4 lg:justify-start lg:min-h-0 lg:overflow-hidden">
      <header className="shrink-0 text-center">
        <h2 className="text-3xl font-bold text-green-400 mb-2">
          {mode === 'local' ? 'Local Match' : 'Online Match'}
          {isSpectator && <span className="text-yellow-400 text-lg ml-2">(spectating)</span>}
        </h2>
        <p className="text-gray-500 text-sm">
          {mode === 'local'
            ? 'Add players and configure the match'
            : 'Share the code below and wait for players to connect'}
        </p>
      </header>

      {/* Centred vertically in whatever height is left, but `safe`: a window too short for the
          cards scrolls to the first of them rather than centring the top one out of reach. */}
      <div className={`${LOBBY_COLUMNS} lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:[align-content:safe_center]`}>
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

        {/* Two cards, not one: the match format and the selected mode's settings. */}
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
      </div>

      <div className="shrink-0 flex flex-col items-center gap-4">
        {mode === 'online' && !isSpectator && (ownPlayerIds.length === 0 || lobby.userCount === 1) && (
          <p className="text-yellow-400 text-sm text-center">
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
    </div>
  );
}
