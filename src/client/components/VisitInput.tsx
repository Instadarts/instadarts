import { Box, Button, Group, Modal, Paper, Stack, Text } from '@mantine/core';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
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
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  const visitTotalVisible = textOf(visitTotal) !== '';
  const footerVisible = visitTotalVisible || !hideActions;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const grid = root.querySelector<HTMLElement>('[data-visit-slots]')!;
    const labels = Array.from(root.querySelectorAll<HTMLElement>('[data-visit-slot]'));
    const footer = root.querySelector<HTMLElement>('[data-testid="visit-footer"]');
    let disposed = false;
    const fit = () => {
      if (disposed) return;
      // The root keeps the allocated card height even when its children need to scroll.
      // Probe the same labels at each width; wrapped mode text can change the winning layout.
      const width = root.clientWidth;
      const gap = Number.parseFloat(getComputedStyle(root).gap);
      const itemGap = Number.parseFloat(getComputedStyle(grid).gap);
      const height = root.clientHeight - (footer ? footer.offsetHeight + gap : 0);
      root.style.setProperty('--visit-slot-height', 'auto');
      const measure = (direction: 'row' | 'column') => {
        root.dataset.visitDirection = direction;
        const labelHeight = Math.max(0, ...labels.map((label) => label.offsetHeight));
        const column = direction === 'column';
        const cellWidth = column ? width : (width - itemGap * (dartsPerVisit - 1)) / dartsPerVisit;
        const cellHeight = column ? (height - itemGap * (dartsPerVisit - 1)) / dartsPerVisit : height;
        return { labelHeight, size: Math.max(0, Math.min(cellWidth, cellHeight - labelHeight - gap)) };
      };
      const row = measure('row');
      const column = measure('column');
      const useColumn = column.size > row.size + 1;
      root.dataset.visitDirection = useColumn ? 'column' : 'row';
      root.style.setProperty('--visit-slot-height', `${(useColumn ? column : row).labelHeight}px`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    if (footer) observer.observe(footer);
    void document.fonts.ready.then(fit);
    document.fonts.addEventListener('loadingdone', fit);
    return () => {
      disposed = true;
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', fit);
    };
  });

  return (
    <Stack
      ref={rootRef}
      className="visit-input"
      gap="sm"
      h="100%"
      align="stretch"
      style={{ '--visit-count': dartsPerVisit } as CSSProperties}
    >
      <Box className="visit-input__darts" data-visit-slots>
        {Array.from({ length: dartsPerVisit }, (_, index) => {
          const slot = filled[index];
          return (
            <Box key={index} className="visit-input__dart">
              <Paper
                data-visit-slot
                py={5}
                px="xs"
                radius="sm"
                ta="center"
                ff="monospace"
                // Keep semantic decoration on the score, separate from its evidence.
                data-slot-tone={toneOf(slot) ?? 'default'}
                bg={slot === undefined ? 'var(--instadarts-surface-raised)' : undefined}
                c={slot === undefined ? 'dimmed' : undefined}
                fz="lg"
                style={slot === undefined ? undefined : slotStyle(slot, { size: 'lg' })}
              >
                {slot === undefined ? '--' : textOf(slot)}
              </Paper>
              <Box className="visit-input__evidence-space" data-testid="visit-evidence-space">
                <DartEvidence
                  image={evidence?.[index]}
                  index={index}
                  unavailable={evidence === null || Boolean(darts[index])}
                  onOpen={setOpen}
                />
              </Box>
            </Box>
          );
        })}
      </Box>

      {footerVisible && (
        <Stack gap="sm" data-testid="visit-footer">
          {visitTotalVisible && (
            <Text
              ta="center"
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
      <Modal opened={open !== null} onClose={() => setOpen(null)} title="Dart evidence" centered size="auto">
        {open && <img src={open} alt="" style={{ display: 'block', maxWidth: '90vw', maxHeight: '80dvh', objectFit: 'contain' }} />}
      </Modal>
    </Stack>
  );
}
