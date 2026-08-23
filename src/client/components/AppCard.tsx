import { Box, Card, Divider, Group, Text } from '@mantine/core';
import type { CSSProperties, ReactNode } from 'react';

export interface AppCardProps {
  title?: ReactNode;
  titlePrefix?: ReactNode;
  headerCenter?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  centered?: boolean;
  padding?: 0 | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  contentClassName?: string;
  bodyStyle?: CSSProperties;
}

/** Shared application card. GridBox adds RGL behavior; ordinary pages use this surface directly. */
export function AppCard({
  title,
  titlePrefix,
  headerCenter,
  badge,
  actions,
  children,
  centered = false,
  padding = 'md',
  className,
  headerClassName,
  bodyClassName,
  contentClassName,
  bodyStyle,
}: AppCardProps) {
  const hasHeader = title !== undefined
    || titlePrefix !== undefined
    || headerCenter !== undefined
    || badge !== undefined
    || actions !== undefined;

  return (
    <Card className={className} withBorder radius="lg" padding={0} bg="dark.8" style={{ overflow: 'hidden' }}>
      {hasHeader && (
        <>
          <Group className={headerClassName} gap="sm" px="md" py="sm" wrap="nowrap">
            <Group gap="xs" wrap="nowrap" miw={0} style={{ flex: '0 1 auto' }}>
              {titlePrefix}
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
        className={bodyClassName}
        p={padding}
        style={{
          ...(centered ? { display: 'grid', placeItems: 'center' } : {}),
          ...bodyStyle,
        }}
      >
        <Box className={contentClassName} data-grid-box-content>
          {children}
        </Box>
      </Box>
    </Card>
  );
}
