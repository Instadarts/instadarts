import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Stack, Text, TextInput } from '@mantine/core';
import { CameraIcon } from '../components/AppIcons';
import { Wordmark } from '../components/Wordmark';
import { APP_VERSION } from '../lib/version';
import { GridBox } from '../layout/GridBox';
import { ResponsiveBoxGrid } from '../layout/ResponsiveBoxGrid';
import { HOME_LAYOUTS } from '../layout/frontendLayout';

interface HomePageProps {
  onCreateLocalMatch: () => void;
  onCreateOnlineMatch: () => void;
  /** Opens the same pairing dialog the top bar's camera menu does. */
  onPairDevice: () => void;
  /** No scoring device has ever been paired to this browser. */
  unpaired: boolean;
  connected: boolean;
  notice?: string | null;
}

export function HomePage({
  onCreateLocalMatch,
  onCreateOnlineMatch,
  onPairDevice,
  unpaired,
  connected,
  notice,
}: HomePageProps) {
  const [showJoin, setShowJoin] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const navigate = useNavigate();

  // Deliberately not a `centered` GridBox. `centered` makes the card's content box shrink to fit,
  // and a shrink-to-fit box is the one thing the wordmark's auto-fit cannot measure against: the
  // fitted line is the widest thing in the box, so the box is as wide as the line and the two settle
  // on whatever size they first agreed on instead of on the card's. It also left the box as wide as
  // whatever the longest line of prose happened to be, so editing the subtitle resized the title.
  // The Stack centres its own children, so nothing here needs the card to do it.
  const welcome = (
    <GridBox editable={false}>
      <Stack align="center" gap="xs" ta="center" py="xl" pos="relative">
        <Wordmark component="h1" fitTo={48} />
        <Text c="dimmed" fz="lg">Open Source AI darts scoring app.</Text>
        {notice && <Alert color="yellow" role="status">{notice}</Alert>}
        {/* Out of the flow on purpose: it is here for the person filing a bug report, and a stamp in
            the corner neither moves the wordmark above it nor changes the card's measured height. */}
        <Text pos="absolute" bottom={0} right={0} c="dimmed" opacity={0.7} fz="xs" ff="monospace">
          v{APP_VERSION}
        </Text>
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
          {/* First and pulsing, only until this browser has paired something. A camera that scores
              the board is what the application is for, and somebody arriving here for the first time
              has no reason to suspect it: the alternative is that they play a match tapping the
              board by hand and never learn the feature exists. Once one device is paired the button
              is gone for good — the top bar's camera menu is where a second one is added. */}
          {unpaired && (
            <Button
              className="button-hint"
              size="xl"
              leftSection={<CameraIcon />}
              onClick={onPairDevice}
              disabled={!connected}
            >
              Pair a Scoring Device
            </Button>
          )}
          <Button size="xl" color="blue" onClick={onCreateLocalMatch} disabled={!connected}>Local Match</Button>
          <Button size="xl" onClick={onCreateOnlineMatch} disabled={!connected}>Online Match</Button>
          <Button size="xl" variant="default" onClick={() => setShowJoin(true)} disabled={!connected}>Join Online Match</Button>
        </Stack>
      )}
    </GridBox>
  );

  // The one item on this page that is not a card: it offers a way off the page rather than something
  // to do on it, and a third bordered panel gave it the weight of a fourth way to start a match. It
  // stays a grid item so it keeps the column width and centring of the cards above it.
  const scorer = (
    <Stack maw={420} mx="auto" gap="xs" align="stretch">
      <Text c="dimmed" fz="sm" ta="center">
        If this is a scoring device click here.
      </Text>
      {/* Deliberately a plain anchor rather than a router link: /scorer is a sibling application
          that main.tsx chooses from the path at load, so a client-side navigation would find no
          route here and send the device straight back to this page. */}
      <Button
        component="a"
        href="/scorer"
        size="md"
        variant="default"
        leftSection={<CameraIcon />}
      >
        I'm a scoring device
      </Button>
    </Stack>
  );

  return (
    <ResponsiveBoxGrid
      defaultLayouts={HOME_LAYOUTS}
      items={[
        { id: 'welcome', content: welcome, autoHeight: true },
        { id: 'actions', content: actions, autoHeight: true },
        { id: 'scorer', content: scorer, autoHeight: true },
      ]}
    />
  );
}
