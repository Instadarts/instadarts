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

interface LobbyPageProps {
  lobby: Lobby;
  modes: ModeDescriptor[];
  mode: 'local' | 'online';
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
  mode,
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
  const managed = Boolean(lobby.apiManaged);
  const canStart = lobby.players.length >= 1;
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
                {managed ? 'Invited Match' : mode === 'local' ? 'Local Match' : 'Online Match'}
                {isSpectator && <Text span c="var(--instadarts-tone-warning-fg)" fz="lg"> (spectating)</Text>}
              </Title>
              <Text c="dimmed" fz="sm">
                {managed ? 'The organizer has fixed the players and match settings' : mode === 'local'
                  ? 'Add players and configure the match'
                  : 'Share the code and wait for players to connect'}
              </Text>
            </Stack>
            <Group gap="sm">
              {!managed && !isSpectator && isCreator && (
                <Button onClick={onStartGame} disabled={!canStart}>Start Match</Button>
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
              {managed ? `${lobby.joinedPlayerIds?.length ?? 0}/${lobby.players.length} joined` : lobby.players.length >= lobby.maxPlayers
                ? `Full — ${lobby.maxPlayers} max`
                : `${lobby.players.length}/${lobby.maxPlayers}`}
            </Badge>
          )}
          editable={false}
        >
          <PlayerList
            players={lobby.players}
            locked={managed}
            joinedPlayerIds={lobby.joinedPlayerIds}
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

  if (!managed && isCreator && mode === 'online') {
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
