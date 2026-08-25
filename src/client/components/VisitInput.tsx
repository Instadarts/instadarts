import { Box, Button, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import type { DartThrow, ViewText } from '../../shared/types';
import { textOf, toneOf } from '../../shared/types';
import { DartEvidence } from './DartEvidence';
import { modeTextProps, slotStyle } from './modeText';

interface VisitInputProps {
  darts: DartThrow[];
  dartsPerVisit: number;
  slots?: ViewText[];
  visitTotal: ViewText;
  onUndoDart: () => void;
  onSubmit: () => void;
  readOnly?: boolean;
  hideActions?: boolean;
  evidence: (string | undefined)[] | null;
}

const VISIT_COLUMN_SPACING = 12;
const MINIMUM_EVIDENCE_SIZE = 48;

export function VisitInput({
  darts,
  dartsPerVisit,
  slots,
  visitTotal,
  onUndoDart,
  onSubmit,
  readOnly,
  hideActions,
  evidence,
}: VisitInputProps) {
  const filled: ViewText[] = slots ?? darts.map((dart) => `${dart.score.label} (${dart.score.points})`);
  const empty = Math.max(0, dartsPerVisit - filled.length);
  const visitTotalVisible = textOf(visitTotal) !== '';
  const footerVisible = visitTotalVisible || !hideActions;

  return (
    <Stack
      gap="sm"
      h="100%"
      align="stretch"
      data-testid="visit-input"
      style={{ minHeight: 'max-content' }}
    >
      <SimpleGrid cols={dartsPerVisit} spacing={VISIT_COLUMN_SPACING} data-visit-slots>
        {filled.map((slot, index) => (
          <Paper
            key={index}
            py={5}
            px="xs"
            radius="sm"
            ta="center"
            ff="monospace"
            // The slot's semantic tone, reflected so a mode's own stylesheet can decorate on it.
            // Generic on purpose: this says what the mode said, and knows about no mode.
            data-slot-tone={toneOf(slot) ?? 'default'}
            style={slotStyle(slot, { size: 'lg' })}
          >
            {textOf(slot)}
          </Paper>
        ))}
        {Array.from({ length: empty }).map((_, index) => (
          <Paper key={`empty-${index}`} py={5} px="xs" radius="sm" ta="center" ff="monospace" bg="dark.6" c="gray.6" fz="lg">
            --
          </Paper>
        ))}
      </SimpleGrid>

      <Box
        data-testid="visit-evidence-space"
        style={{
          containerType: 'size',
          display: 'grid',
          flex: '1 1 0',
          minHeight: evidence ? MINIMUM_EVIDENCE_SIZE : 0,
          placeItems: 'center',
        }}
      >
        {evidence && (
          <DartEvidence images={evidence} slots={dartsPerVisit} spacing={VISIT_COLUMN_SPACING} />
        )}
      </Box>

      {footerVisible && (
        <Stack gap="sm" data-testid="visit-footer">
          {visitTotalVisible && (
            <Text
              ta="center"
              data-testid="visit-score"
              {...modeTextProps(visitTotal, { tone: 'warning', size: 'xl', weight: 'bold' })}
            >
              Visit: {textOf(visitTotal)}
            </Text>
          )}

          {!hideActions && (
            <Group justify="center" gap="sm">
              <Button variant="default" onClick={onUndoDart} disabled={darts.length === 0 || (readOnly ?? false)}>Undo</Button>
              <Button onClick={onSubmit} disabled={readOnly ?? false}>Submit Visit</Button>
            </Group>
          )}
        </Stack>
      )}
    </Stack>
  );
}
