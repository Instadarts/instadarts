import { useState } from 'react';
import { ActionIcon, Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { storage } from '../lib/storage';
import type { Player } from '../../shared/types';

interface PlayerListProps {
  players: Player[];
  maxPlayers: number;
  isCreator: boolean;
  isSpectator: boolean;
  ownPlayerIds: string[];
  onAdd: (name: string) => void;
  onRemove: (playerId: string) => void;
  onReorder?: (playerId: string, direction: 'up' | 'down') => void;
}

function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const value = n % 100;
  return n + (suffixes[(value - 20) % 10] || suffixes[value] || suffixes[0]);
}

export function PlayerList({
  players,
  maxPlayers,
  isCreator,
  isSpectator,
  ownPlayerIds,
  onAdd,
  onRemove,
  onReorder,
}: PlayerListProps) {
  const [newName, setNewName] = useState('');
  const savedNames = storage.getPlayerNames();
  const usedNames = new Set(players.map((player) => player.name.toLowerCase()));
  const availableNames = savedNames.filter((name) => !usedNames.has(name.toLowerCase()));
  const canAdd = players.length < maxPlayers;
  const isMine = (playerId: string) => ownPlayerIds.includes(playerId);
  const isDuplicate = (name: string) => usedNames.has(name.trim().toLowerCase());

  const add = (raw: string) => {
    const name = raw.trim();
    if (!name || isDuplicate(name)) return;
    storage.addPlayerName(name);
    onAdd(name);
    setNewName('');
  };

  return (
    <Stack gap="sm">
      <Stack gap={0}>
        {players.map((player, index) => (
          <Group key={player.id} py="xs" gap="xs" wrap="nowrap" style={{ borderBottom: '1px solid var(--instadarts-border)' }}>
            <Text c="dimmed" fz="xs" w={34}>{ordinal(index + 1)}</Text>
            <Text style={{ flex: 1 }} truncate>{player.name}</Text>

            {!isSpectator && isCreator && onReorder && players.length >= 2 && (
              <Group gap={2} wrap="nowrap">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  onClick={() => onReorder(player.id, 'up')}
                  disabled={index === 0}
                  title="Move up"
                >
                  ▲
                </ActionIcon>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  onClick={() => onReorder(player.id, 'down')}
                  disabled={index === players.length - 1}
                  title="Move down"
                >
                  ▼
                </ActionIcon>
              </Group>
            )}

            {!isSpectator && (isMine(player.id) || isCreator) && (
              <ActionIcon
                size="sm"
                variant="subtle"
                color="red"
                onClick={() => onRemove(player.id)}
                title={isMine(player.id) ? 'Remove player' : 'Kick player'}
              >
                ✕
              </ActionIcon>
            )}
          </Group>
        ))}
      </Stack>

      {!isSpectator && canAdd && (
        <Stack gap="sm">
          {availableNames.length > 0 && (
            <Group gap="xs">
              {availableNames.map((name) => (
                <Button key={name} variant="light" color="gray" onClick={() => add(name)}>
                  + {name}
                </Button>
              ))}
            </Group>
          )}
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <TextInput
              label="New player"
              placeholder="Player name"
              value={newName}
              onChange={(event) => setNewName(event.currentTarget.value)}
              onKeyDown={(event) => event.key === 'Enter' && add(newName)}
              maxLength={20}
              style={{ flex: 1 }}
            />
            <Button onClick={() => add(newName)} disabled={!newName.trim() || isDuplicate(newName)}>Add</Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
