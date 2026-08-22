import { Alert, Badge, Button, Group, Stack, Text, Title } from '@mantine/core';
import type { Lobby } from '../../shared/types';
import type { ModeDescriptor } from '../../shared/settings';
import { PlayerList } from '../components/PlayerList';
import { MatchFormatFields, ModeSettingsFields } from '../components/MatchSettingsPanel';
import { InvitePanel } from '../components/InvitePanel';
import { ResponsiveBoxGrid, type ResponsiveBoxItem } from '../layout/ResponsiveBoxGrid';
import { GridBox } from '../layout/GridBox';
import { LOBBY_LAYOUT, LOBBY_LAYOUTS } from '../layout/frontendLayout';

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
  const canStart = lobby.players.length >= 1;
  const canEdit = !isSpectator && isCreator;
  const descriptor = modes.find((candidate) => candidate.id === lobby.settings.mode);
  const waiting = mode === 'online' && !isSpectator && (ownPlayerIds.length === 0 || lobby.userCount === 1);

  const items: ResponsiveBoxItem[] = [
    {
      id: 'overview',
      autoHeight: true,
      content: (
        <GridBox editable={false}>
          <Group justify="space-between" align="center" gap="lg">
            <Stack gap={2}>
              <Title order={2} c="green.4">
                {mode === 'local' ? 'Local Match' : 'Online Match'}
                {isSpectator && <Text span c="yellow.4" fz="lg"> (spectating)</Text>}
              </Title>
              <Text c="dimmed" fz="sm">
                {mode === 'local'
                  ? 'Add players and configure the match'
                  : 'Share the code and wait for players to connect'}
              </Text>
            </Stack>
            <Group gap="sm">
              {!isSpectator && isCreator && (
                <Button onClick={onStartGame} disabled={!canStart}>Start Match</Button>
              )}
              <Button variant="default" onClick={onLeave}>Leave</Button>
            </Group>
          </Group>
          {
            <Alert color="dark" mt="md">
              {ownPlayerIds.length === 0
                ? 'Add at least one player to start'
                : 'Add more players or start the match'}
            </Alert>
          }
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
              {lobby.players.length >= lobby.maxPlayers
                ? `Full — ${lobby.maxPlayers} max`
                : `${lobby.players.length}/${lobby.maxPlayers}`}
            </Badge>
          )}
          editable={false}
        >
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

  if (isCreator && mode === 'online') {
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

  return <ResponsiveBoxGrid defaultLayout={LOBBY_LAYOUT} defaultLayouts={LOBBY_LAYOUTS} items={items} />;
}
