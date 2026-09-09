import { useState } from 'react';
import { Alert, Badge, Button, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import type { Lobby } from '../../shared/types';
import type { ModeDescriptor } from '../../shared/settings';
import { PlayerList } from '../components/PlayerList';
import { MatchFormatFields, ModeSettingsFields } from '../components/MatchSettingsPanel';
import { InvitePanel } from '../components/InvitePanel';
import { ResponsiveBoxGrid, type ResponsiveBoxItem } from '../layout/ResponsiveBoxGrid';
import { GridBox } from '../layout/GridBox';
import { LOBBY_LAYOUTS } from '../layout/frontendLayout';

/**
 * The three kinds of lobby there are, as one value.
 *
 * `apiManaged` and `acceptsJoins` are not independent: an API lobby has no shared code, so it is
 * never the "online" one. Read as two booleans they invited a branch that answers `local` for a
 * managed lobby by simply not asking — which is what a caller passing `mode` from `acceptsJoins`
 * alone was doing. Derived here, from the lobby that already says so, and exhaustive: a fourth kind
 * is a compile error in every table below rather than a screen that silently picks a wrong label.
 */
type LobbyKind = 'local' | 'online' | 'managed';

function kindOf(lobby: Lobby): LobbyKind {
  if (lobby.apiManaged) return 'managed';
  return lobby.acceptsJoins ? 'online' : 'local';
}

/** What the home screen calls each kind. See docs/glossary.md — this is the interface's vocabulary. */
const TITLE: Record<LobbyKind, string> = {
  local: 'Local Match',
  online: 'Online Match',
  managed: 'Invited Match',
};

const SUBTITLE: Record<LobbyKind, string> = {
  local: 'Add players and configure the match',
  online: 'Share the code and wait for players to connect',
  managed: 'The organizer has fixed the players and match settings',
};

interface LobbyPageProps {
  lobby: Lobby;
  modes: ModeDescriptor[];
  isCreator: boolean;
  ownPlayerIds: string[];
  isSpectator: boolean;
  onStartGame: () => void;
  onJoinPlayer?: (code: string) => void;
  error?: string | null;
  onLeave: () => void;
  onUpdateSettings: (settings: any) => void;
  onAddLocalPlayer: (name: string) => void;
  onRemovePlayer: (playerId: string) => void;
  onReorderPlayer?: (playerId: string, direction: 'up' | 'down') => void;
}

export function LobbyPage({
  lobby,
  modes,
  isCreator,
  ownPlayerIds,
  isSpectator,
  onStartGame,
  onJoinPlayer,
  error,
  onLeave,
  onUpdateSettings,
  onAddLocalPlayer,
  onRemovePlayer,
  onReorderPlayer,
}: LobbyPageProps) {
  const [inviteCode, setInviteCode] = useState('');
  const kind = kindOf(lobby);
  // The server sends `joinedPlayerIds` only for an API lobby, which is also the only kind that is
  // locked — so one value answers both questions the roster box asks.
  const managed = kind === 'managed' ? { joinedPlayerIds: lobby.joinedPlayerIds ?? [] } : undefined;
  const canEdit = !managed && !isSpectator && isCreator;
  const descriptor = modes.find((candidate) => candidate.id === lobby.settings.mode);
  const items: ResponsiveBoxItem[] = [
    {
      id: 'overview',
      autoHeight: true,
      content: (
        <GridBox editable={false}>
          <Group justify="space-between" align="center" gap="lg">
            <Stack gap={2}>
              <Title order={2} c="var(--instadarts-accent)">
                {TITLE[kind]}
                {isSpectator && <Text span c="var(--instadarts-tone-warning-fg)" fz="lg"> (spectating)</Text>}
              </Title>
              <Text c="dimmed" fz="sm">{SUBTITLE[kind]}</Text>
            </Stack>
            <Group gap="sm">
              {!managed && !isSpectator && isCreator && (
                <Button onClick={onStartGame} disabled={lobby.players.length < 1}>Start Match</Button>
              )}
              <Button variant="default" onClick={onLeave}>Leave</Button>
            </Group>
          </Group>
          <Alert variant="default" mt="md">
            {managed ? 'The match starts automatically when all players have joined' : ownPlayerIds.length === 0
              ? 'Add at least one player to start'
              : 'Add more players or start the match'}
          </Alert>
          {error && <Alert color="red" mt="sm">{error}</Alert>}
        </GridBox>
      ),
    },
    {
      id: 'players',
      autoHeight: true,
      content: (
        <GridBox
          title="Players"
          badge={(
            <Badge variant="light" color={lobby.players.length >= lobby.maxPlayers ? 'red' : 'gray'}>
              {managed ? `${managed.joinedPlayerIds.length}/${lobby.players.length} joined` : lobby.players.length >= lobby.maxPlayers
                ? `Full — ${lobby.maxPlayers} max`
                : `${lobby.players.length}/${lobby.maxPlayers}`}
            </Badge>
          )}
          editable={false}
        >
          <PlayerList
            players={lobby.players}
            managed={managed}
            maxPlayers={lobby.maxPlayers}
            isCreator={isCreator}
            isSpectator={isSpectator}
            ownPlayerIds={ownPlayerIds}
            onAdd={onAddLocalPlayer}
            onRemove={onRemovePlayer}
            onReorder={onReorderPlayer}
          />
          {managed && !isSpectator && onJoinPlayer && (
            <Group mt="md" align="flex-end">
              <TextInput label="Player invite code" value={inviteCode} maxLength={6}
                onChange={(event) => setInviteCode(event.currentTarget.value.toUpperCase())} />
              <Button disabled={inviteCode.trim().length !== 6}
                onClick={() => { onJoinPlayer(inviteCode.trim()); setInviteCode(''); }}>
                Add player by invite code
              </Button>
            </Group>
          )}
        </GridBox>
      ),
    },
    {
      id: 'match-settings',
      autoHeight: true,
      content: (
        <GridBox title="Match format" editable={false}>
          <MatchFormatFields settings={lobby.settings} modes={modes} canEdit={canEdit} onChange={onUpdateSettings} />
        </GridBox>
      ),
    },
  ];

  if (descriptor) {
    items.push({
      id: 'mode-settings',
      autoHeight: true,
      content: (
        <GridBox title={`${descriptor.label} settings`} editable={false}>
          <ModeSettingsFields settings={lobby.settings} modes={modes} canEdit={canEdit} onChange={onUpdateSettings} />
        </GridBox>
      ),
    });
  }

  if (kind === 'online' && isCreator) {
    items.push({
      id: 'invite',
      autoHeight: true,
      content: (
        <GridBox title="Invite" editable={false} centered>
          <InvitePanel
            inviteCode={lobby.inviteCode}
            userCount={lobby.userCount}
            maxPlayers={lobby.maxPlayers}
            isClosed={!lobby.admitting}
          />
        </GridBox>
      ),
    });
  }

  return <ResponsiveBoxGrid defaultLayouts={LOBBY_LAYOUTS} items={items} />;
}
