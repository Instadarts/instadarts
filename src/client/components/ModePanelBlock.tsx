import { Box, Stack, Table, Text } from '@mantine/core';
import type { ModePanel } from '../../shared/types';
import { textOf } from '../../shared/types';
import { modeTextProps } from './modeText';
import { MODE_PANELS } from '../modes/panels';

interface ModePanelBlockProps {
  modeId: string;
  panel: ModePanel;
}

export function ModePanelBlock({ modeId, panel }: ModePanelBlockProps) {
  const Custom = panel.render === 'table' ? undefined : MODE_PANELS[modeId];
  const playerIds = [...new Set(panel.rows.flatMap((row) => Object.keys(row.values)))];
  const empty = panel.rows.length === 0 && !panel.lines?.length && panel.custom === undefined;
  if (empty) return null;

  return (
    <Stack align="stretch" gap="xs" justify="center" h="100%">
      {panel.lines?.map((line, index) => (
        <Text key={index} ta="center" {...modeTextProps(line, { size: 'sm', tone: 'muted' })}>
          {textOf(line)}
        </Text>
      ))}

      {Custom ? (
        <Custom panel={panel} />
      ) : panel.rows.length > 0 && (
        <Box style={{ overflowX: 'auto' }}>
          <Table fz="sm" striped>
            <Table.Tbody>
              {panel.rows.map((row) => (
                <Table.Tr key={row.label}>
                  <Table.Td c="dimmed">{row.label}</Table.Td>
                  {playerIds.map((playerId) => (
                    <Table.Td key={playerId} ta="center">
                      <Text span ff="monospace" {...modeTextProps(row.values[playerId], { size: 'sm' })}>
                        {textOf(row.values[playerId])}
                      </Text>
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      )}
    </Stack>
  );
}
