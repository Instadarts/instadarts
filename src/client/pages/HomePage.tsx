import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Stack, Text, TextInput, Title } from '@mantine/core';
import type { Layout, ResponsiveLayouts } from 'react-grid-layout';
import { GridBox } from '../layout/GridBox';
import { ResponsiveBoxGrid } from '../layout/ResponsiveBoxGrid';
import type { FrontendBreakpoint } from '../layout/frontendLayout';

interface HomePageProps {
  onCreateLocalMatch: () => void;
  onCreateOnlineMatch: () => void;
  connected: boolean;
  notice?: string | null;
}

function homeLayout(x: number, width: number): Layout {
  return [
    { i: 'welcome', x, y: 0, w: width, h: 11 },
    { i: 'actions', x, y: 11, w: width, h: 16 },
  ];
}

const HOME_LAYOUT = homeLayout(3, 6);
const HOME_LAYOUTS: ResponsiveLayouts<FrontendBreakpoint> = {
  lg: HOME_LAYOUT,
  md: homeLayout(2, 6),
  sm: homeLayout(1, 4),
  xs: homeLayout(0, 4),
  xxs: homeLayout(0, 2),
};

export function HomePage({
  onCreateLocalMatch,
  onCreateOnlineMatch,
  connected,
  notice,
}: HomePageProps) {
  const [showJoin, setShowJoin] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const navigate = useNavigate();

  const welcome = (
    <GridBox editable={false} centered>
      <Stack align="center" gap="xs" ta="center" py="xl">
        <Title order={1} c="green.4" fz="3rem">InstaDarts</Title>
        <Text c="dimmed" fz="lg">Dart game tracker</Text>
        {notice && <Alert color="yellow" role="status">{notice}</Alert>}
      </Stack>
    </GridBox>
  );

  const actions = (
    <GridBox title={showJoin ? 'Join an online match' : 'Start playing'} editable={false}>
      {showJoin ? (
        <Stack maw={360} mx="auto" gap="md">
          <TextInput
            label="Invite code"
            placeholder="ABC123"
            value={joinCode}
            onChange={(event) => setJoinCode(event.currentTarget.value.toUpperCase())}
            maxLength={6}
            autoFocus
            size="lg"
            styles={{ input: { textAlign: 'center', letterSpacing: '0.2em', fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
          <Button
            size="lg"
            onClick={() => navigate(`/lobby/join/${joinCode.trim().toUpperCase()}`)}
            disabled={joinCode.length < 4 || !connected}
          >
            Join Match
          </Button>
          <Button size="lg" variant="default" onClick={() => setShowJoin(false)}>Back</Button>
        </Stack>
      ) : (
        <Stack maw={420} mx="auto" gap="md">
          <Button size="xl" color="blue" onClick={onCreateLocalMatch} disabled={!connected}>Local Match</Button>
          <Button size="xl" onClick={onCreateOnlineMatch} disabled={!connected}>Create Online Match</Button>
          <Button size="xl" variant="default" onClick={() => setShowJoin(true)} disabled={!connected}>Join Online Match</Button>
        </Stack>
      )}
    </GridBox>
  );

  return (
    <ResponsiveBoxGrid
      defaultLayout={HOME_LAYOUT}
      defaultLayouts={HOME_LAYOUTS}
      items={[
        { id: 'welcome', content: welcome, autoHeight: true },
        { id: 'actions', content: actions, autoHeight: true },
      ]}
    />
  );
}
