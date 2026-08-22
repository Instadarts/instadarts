import type { ModePanelProps } from './panels';
import type { ModePanel } from '../../shared/types';
import { textOf } from '../../shared/types';
import { Box, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';

// x01's optional second file.
//
// A game mode is one file on the server; this is the other half a mode may add when it wants to draw
// its panel itself. It is found by filename — `src/client/modes/x01.tsx` — with no registry to edit,
// and deleting it costs nothing: the match screen falls back to rendering the same rows as a plain
// table. Everything below is presentation.
//
// It reads two things: the `rows` any mode describes, laid out per player instead of per statistic,
// and the `custom` payload x01 sends for its own use — recent visit scores, drawn as bars, which is
// the shape a table cannot express and the reason this file exists.
//
// **However many players there are.** The roster is read off the rows rather than assumed, one card
// is drawn per player, and the cards wrap — so a five-handed match is more of the same rather than a
// second layout. `leads` compares a player against every other one, not against an opponent.

/** The headline number on each card. The rest of the rows are listed underneath it. */
const HEADLINE = '3-dart average';

/**
 * Which way is better, per row.
 *
 * Fewer darts is a better leg and more of them is a worse one, so "highest wins" would praise the
 * wrong player. Knowing that is exactly the sort of thing a mode's own component is for; a row not
 * listed here is simply never highlighted.
 */
const BETTER: Record<string, 'higher' | 'lower'> = {
  '3-dart average': 'higher',
  'Scoring average': 'higher',
  '180s': 'higher',
  'Legs won': 'higher',
  'Darts this leg': 'lower',
  'Best leg (darts)': 'lower',
};

interface Recent {
  recent: Record<string, number[]>;
  max: number;
}

export default function X01Panel({ panel }: ModePanelProps) {
  const playerIds = [...new Set(panel.rows.flatMap((row) => Object.keys(row.values)))];
  const { recent, max } = (panel.custom ?? { recent: {}, max: 180 }) as Recent;

  const headline = panel.rows.find((row) => row.label === HEADLINE);
  const rest = panel.rows.filter((row) => row.label !== HEADLINE);

  return (
    <SimpleGrid minColWidth={130} autoFlow="auto-fit" spacing="sm">
      {playerIds.map((playerId) => (
        <Paper key={playerId} bg="dark.9" radius="md" px="md" py="sm">
          <Stack gap="sm">
          {headline && (
            <Stack gap={0} ta="center">
              <Text fz="xl" fw={700} ff="monospace" c={leads(headline, playerId, playerIds) ? 'green.4' : 'gray.3'}>
                {textOf(headline.values[playerId])}
              </Text>
              <Text fz={10} tt="uppercase" c="dimmed">{headline.label}</Text>
            </Stack>
          )}

          <Bars scores={recent[playerId] ?? []} max={max} />

          <Stack component="dl" gap={2} fz="xs">
            {rest.map((row) => (
              <Group key={row.label} justify="space-between" gap="md" wrap="nowrap">
                <Text component="dt" c="dimmed">{row.label}</Text>
                <Text component="dd" ff="monospace" c={leads(row, playerId, playerIds) ? 'green.4' : 'gray.3'}>
                  {textOf(row.values[playerId])}
                </Text>
              </Group>
            ))}
          </Stack>
          </Stack>
        </Paper>
      ))}
    </SimpleGrid>
  );
}

/**
 * The last few visits as bars, tallest at a maximum.
 *
 * Empty slots are kept so the row keeps its width as a leg fills up, rather than growing under the
 * player's eye.
 */
function Bars({ scores, max }: { scores: number[]; max: number }) {
  const slots = [...Array(6)].map((_, i) => scores[scores.length - 6 + i]);

  return (
    <Group align="flex-end" gap={4} h={32} aria-hidden wrap="nowrap">
      {slots.map((score, i) => (
        <Box key={i} bg="dark.6" h="100%" style={{ flex: 1, borderRadius: 2, display: 'flex', alignItems: 'flex-end' }}>
          {score !== undefined && (
            <Box
              bg={score >= 100 ? 'green.5' : score > 0 ? 'green.8' : 'red.9'}
              style={{ height: `${Math.max(6, (Math.min(score, max) / max) * 100)}%`, width: '100%', borderRadius: 2 }}
              title={String(score)}
            />
          )}
        </Box>
      ))}
    </Group>
  );
}

/** Whether this player has the best of a row, so the eye can find it. A tie leads nothing. */
function leads(row: ModePanel['rows'][number], playerId: string, playerIds: string[]): boolean {
  const direction = BETTER[row.label];
  if (!direction) return false;

  const value = Number(textOf(row.values[playerId]));
  if (!Number.isFinite(value)) return false;

  const others = playerIds
    .filter((id) => id !== playerId)
    .map((id) => Number(textOf(row.values[id])))
    .filter(Number.isFinite);

  if (others.length === 0) return false;
  return direction === 'higher'
    ? others.every((other) => value > other)
    : others.every((other) => value < other);
}
