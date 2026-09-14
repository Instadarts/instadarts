import { Switch, Text } from '@mantine/core';
import { Fragment, type ReactNode } from 'react';
import { AppCard } from '../components/AppCard';
import { useGridItemChrome } from './GridItemChromeContext';
import { useLayoutEditor } from './LayoutEditorContext';

interface GridBoxProps {
  title?: ReactNode;
  /** A mark shown ahead of the title, beside the drag handle when a match grid is being edited. */
  titlePrefix?: ReactNode;
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
  titlePrefix,
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
  // The edit handle and a card's own mark share AppCard's single prefix slot. The handle comes
  // first, since in edit mode it is the thing being reached for; the mark leaves with the rest of
  // the header content when the title bar is switched off, because it names a card nobody can see.
  const handle = showHandle ? (
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
          size="xs"
          checked={titleBarVisible}
          onChange={(event) => chrome.setTitleBarVisible?.(event.currentTarget.checked)}
          aria-label="Show title bar"
          title={titleBarVisible ? 'Hide title bar' : 'Show title bar'}
        />
      )}
    </Fragment>
  ) : null;
  const mark = showHeaderContent ? titlePrefix : undefined;

  return (
    <AppCard
      title={showHeaderContent ? title : undefined}
      titlePrefix={handle === null && mark === undefined ? undefined : (
        <Fragment>
          {handle}
          {mark}
        </Fragment>
      )}
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
