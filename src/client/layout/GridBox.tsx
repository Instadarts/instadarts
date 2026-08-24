import { Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { AppCard } from '../components/AppCard';
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
  const hasConfiguredHeader = title !== undefined
    || headerCenter !== undefined
    || badge !== undefined
    || actions !== undefined;
  const overlayEditHeader = showHandle && !hasConfiguredHeader;
  return (
    <AppCard
      title={title}
      titlePrefix={showHandle ? (
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
      ) : undefined}
      headerCenter={headerCenter}
      badge={badge}
      actions={actions}
      centered={centered}
      padding={padding}
      className={`frontend-grid-box${overlayEditHeader ? ' frontend-grid-box--edit-header-overlay' : ''}`}
      headerClassName="frontend-grid-box__header"
      bodyClassName="frontend-grid-box__body"
      contentClassName="frontend-grid-box__content"
    >
      {children}
    </AppCard>
  );
}
