import { Box, Card, Divider, Group, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { useLayoutEditor } from './LayoutEditorContext';

interface GridBoxProps {
  title?: ReactNode;
  headerCenter?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  editable?: boolean;
  centered?: boolean;
  padding?: 'xs' | 'sm' | 'md' | 'lg';
}

export function GridBox({
  title,
  headerCenter,
  badge,
  actions,
  children,
  editable = true,
  centered = false,
  padding = 'md',
}: GridBoxProps) {
  const editor = useLayoutEditor();
  const showHandle = editable && editor.active !== null && editor.editing;
  const hasHeader = title !== undefined || headerCenter !== undefined || badge !== undefined || actions !== undefined || showHandle;

  return (
    <Card className="frontend-grid-box" withBorder radius="lg" padding={0} bg="dark.8">
      {hasHeader && (
        <>
          <Group className="frontend-grid-box__header" gap="sm" px="md" py="sm" wrap="nowrap">
            <Group gap="xs" wrap="nowrap" miw={0} style={{ flex: '0 1 auto' }}>
              {showHandle && (
                <Text
                  component="span"
                  className="frontend-grid-drag-handle"
                  aria-label="Drag box"
                  title="Drag box"
                  c="dimmed"
                  fz="lg"
                >
                  ⠿
                </Text>
              )}
              {title !== undefined && (
                <Text fw={700} tt="uppercase" fz="sm" c="dimmed" truncate>
                  {title}
                </Text>
              )}
            </Group>
            {headerCenter !== undefined && (
              <Box miw={0} style={{ flex: '1 1 0', textAlign: 'center' }}>
                {headerCenter}
              </Box>
            )}
            {(badge !== undefined || actions !== undefined) && (
              <Group gap="xs" wrap="nowrap" ml={headerCenter === undefined ? 'auto' : undefined}>
                {badge}
                {actions}
              </Group>
            )}
          </Group>
          <Divider />
        </>
      )}
      <Box
        className="frontend-grid-box__body"
        p={padding}
        style={centered ? { display: 'grid', placeItems: 'center' } : undefined}
      >
        <Box className="frontend-grid-box__content" data-grid-box-content>
          {children}
        </Box>
      </Box>
    </Card>
  );
}
