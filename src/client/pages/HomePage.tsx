import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Anchor, Button, Stack, Text, TextInput } from '@mantine/core';
import { CameraIcon, GithubIcon } from '../components/AppIcons';
import { Wordmark } from '../components/Wordmark';
import { APP_VERSION } from '../lib/version';
import { PROJECT_LINKS } from '../lib/links';
import { GridBox } from '../layout/GridBox';
import { ResponsiveBoxGrid } from '../layout/ResponsiveBoxGrid';
import { HOME_LAYOUTS } from '../layout/frontendLayout';

// Where somebody stuck, annoyed or curious goes next. The three destinations answer three different
// questions — how do I use this, this is broken, how do I change it — so each carries the line of
// prose that tells them apart; the labels alone read as three names for the same repository.
const HELP_LINKS = [
  {
    href: PROJECT_LINKS.readme,
    label: 'Help and documentation',
    description: 'Setting up a scoring device, playing a first match, and running your own server.',
  },
  {
    href: PROJECT_LINKS.issues,
    label: 'Report an issue or suggest a feature',
    description: 'Bug reports and ideas both belong in the issue tracker.',
  },
  {
    href: PROJECT_LINKS.contributing,
    label: 'Develop and contribute',
    description: 'How to build InstaDarts, and what a pull request needs before it is opened.',
  },
] as const;

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

  // Deliberately quiet: reference material, not a fourth way to start a match. Anchors and a line of
  // prose each keep the large buttons above it the loudest thing on the page, and the card sits last
  // because nobody arrives here looking for it — they arrive here having already tried something.
  const help = (
    <GridBox
      title="InstaDarts Links"
      // Dimmed to sit with the title rather than in front of it: the mark is there to say where
      // these three links go, which is a label, not a button.
      titlePrefix={<Text component="span" c="dimmed"><GithubIcon size={18} /></Text>}
      editable={false}
    >
      <Stack maw={420} mx="auto" gap="md">
        {HELP_LINKS.map(({ href, label, description }) => (
          <Stack key={href} gap={2}>
            {/* External destinations, so a plain anchor in a new tab: a match or a pairing dialog
                left open in this one survives the trip to GitHub. */}
            <Anchor href={href} target="_blank" rel="noopener noreferrer" fw={600}>
              {/* Decoration, so it stays out of the link's accessible name: a screen reader
                  announcing "black right-pointing triangle" ahead of every one of these is noise. */}
              <span aria-hidden="true">➤{"\t"}</span>{label}
            </Anchor>
            <Text c="dimmed" fz="sm" ml="1.5em">{description}</Text>
          </Stack>
        ))}
      </Stack>
    </GridBox>
  );

  return (
    <ResponsiveBoxGrid
      defaultLayouts={HOME_LAYOUTS}
      items={[
        { id: 'welcome', content: welcome, autoHeight: true },
        { id: 'actions', content: actions, autoHeight: true },
        { id: 'scorer', content: scorer, autoHeight: true },
        { id: 'help', content: help, autoHeight: true },
      ]}
    />
  );
}
