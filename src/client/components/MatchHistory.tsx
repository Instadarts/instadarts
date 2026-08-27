import { Box, Table, Text } from '@mantine/core';
import type { MatchState } from '../../shared/types';
import { standingsOf } from '../../shared/matchFormat';

interface MatchHistoryProps {
  match: MatchState;
}

export function MatchHistory({ match }: MatchHistoryProps) {
  const standings = standingsOf(match.legs, match.settings);
  const byLeg = match.settings.legsToWinSet === 1;
  if (standings.sets.length === 0) return <Text c="dimmed" fz="sm">No legs were played.</Text>;

  const columns = byLeg
    ? [{ label: 'Legs', valueFor: (playerId: string) => standings.setWins[playerId] ?? 0 }]
    : standings.sets.map((set, index) => ({
        label: `Set ${index + 1}`,
        valueFor: (playerId: string) => set.legWins[playerId] ?? 0,
      }));

  return (
    <Box style={{ overflowX: 'auto' }}>
      <Table striped highlightOnHover fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Player</Table.Th>
            {columns.map((column) => <Table.Th key={column.label} ta="center">{column.label}</Table.Th>)}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {match.players.map((player) => (
            <Table.Tr key={player.id} c={player.id === match.winnerId ? 'var(--instadarts-tone-positive-fg)' : 'dimmed'}>
              <Table.Td>{player.name}</Table.Td>
              {columns.map((column) => (
                <Table.Td key={column.label} ta="center" ff="monospace">{column.valueFor(player.id)}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}
