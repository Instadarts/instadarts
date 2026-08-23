import { useEffect, useState } from 'react';
import { Alert, Button, Center, Stack, Text, TextInput, Title } from '@mantine/core';
import { AppCard } from '../../components/AppCard';

interface JoinViewProps {
  onPair: (code: string) => void;
  pairing: boolean;
  badCode: boolean;
  /** The server has no room for another scoring device right now. Nothing to do but wait. */
  serverFull: boolean;
  connected: boolean;
}

const CODE_LENGTH = 6;

/**
 * Where a phone joins a browser. The code is auto-submitted from `?pair=CODE`, because the usual
 * way to get here is following a link from the screen that is showing the code.
 */
export function JoinView({ onPair, pairing, badCode, serverFull, connected }: JoinViewProps) {
  const [code, setCode] = useState('');

  useEffect(() => {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('pair');
    if (!fromUrl) return;

    setCode(fromUrl.toUpperCase().slice(0, CODE_LENGTH));
    // Spent once it has been offered. A code is single-use, so leaving it in the address bar only
    // means the next visit here — after a reload, or after unpairing — starts with a dead one
    // filled in.
    url.searchParams.delete('pair');
    window.history.replaceState(null, '', url);
  }, []);

  const ready = code.length === CODE_LENGTH && connected && !pairing;

  const submit = () => {
    if (ready) onPair(code);
  };

  return (
    <Center mih="100dvh" p="md" className="app-main">
      <AppCard padding="lg" centered className="scorer-column">
        <Stack align="center" gap="lg" ta="center">
          <Stack gap={2}>
            <Title order={1} c="green.4">Scoring device</Title>
            <Text c="dimmed">Automated darts scoring.</Text>
          </Stack>

          <Text c="gray.4" fz="sm" maw="20rem">
            In InstaDarts, open the top bar and choose <em>Pair scoring device</em>.
          </Text>

          <TextInput
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            value={code}
            onChange={(event) => setCode(event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH))}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
            placeholder="CODE"
            w="14rem"
            size="xl"
            styles={{ input: { textAlign: 'center', fontFamily: 'var(--mantine-font-family-monospace)', letterSpacing: '0.3em' } }}
          />

          {badCode && <Alert color="red">That code was not accepted. Ask for a new one.</Alert>}
          {serverFull && <Alert color="yellow">The server is full. Try again in a moment.</Alert>}
          {!connected && <Alert color="yellow">Connecting to server…</Alert>}

          <Button size="lg" onClick={submit} disabled={!ready} loading={pairing}>
            {pairing ? 'Pairing…' : 'Pair'}
          </Button>
        </Stack>
      </AppCard>
    </Center>
  );
}
