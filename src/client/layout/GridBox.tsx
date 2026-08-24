import { Switch, Text } from '@mantine/core';
import { Fragment, type ReactNode } from 'react';
import { AppCard } from '../components/AppCard';
import { useGridItemChrome } from './GridItemChromeContext';
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
  const chrome = useGridItemChrome();
  const showHandle = editable && editor.active !== null && editor.editing;
  const titleBarVisible = chrome?.titleBarVisible ?? true;
  const showHeaderContent = titleBarVisible || showHandle;
  const overlayEditHeader = showHandle && !titleBarVisible;
  return (
    <AppCard
      title={showHeaderContent ? title : undefined}
      titlePrefix={showHandle ? (
        <Fragment>
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
          {chrome?.setTitleBarVisible && (
            <Switch
              className="frontend-grid-title-bar-toggle"
              size="xs"
              checked={titleBarVisible}
              onChange={(event) => chrome.setTitleBarVisible?.(event.currentTarget.checked)}
              aria-label="Show title bar"
              title={titleBarVisible ? 'Hide title bar' : 'Show title bar'}
            />
          )}
        </Fragment>
      ) : undefined}
      headerCenter={showHeaderContent ? headerCenter : undefined}
      badge={showHeaderContent ? badge : undefined}
      actions={showHeaderContent ? actions : undefined}
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
