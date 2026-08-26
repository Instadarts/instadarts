import { useEffect, useState } from 'react';
import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import type { PairingCode } from '../hooks/useScoringDevices';
import { QrCode } from './QrCode';
import { CopyableText } from './CopyableText';
import { pairingUrl } from '../lib/pairingUrl';

interface PairDeviceDialogProps {
  code: PairingCode | null;
  onRequest: () => void;
  onCancel: () => void;
}

/**
 * The pairing code, as a thing to scan and as a thing to type.
 *
 * The QR is first because it is what the device being paired is best at: a camera phone is already
 * pointed at a screen and already has a scanner, and reading six characters off one screen to tap
 * into another is the slowest part of setting this up. The code stays, in full, for the phone whose
 * scanner will not open, or which is already on the scoring page.
 */
export function PairDeviceDialog({ code, onRequest, onCancel }: PairDeviceDialogProps) {
  const remaining = useCountdown(code?.expiresAt ?? null);
  const scorerUrl = `${window.location.origin}/scorer`;

  // Nothing is requested from here. Whoever opened this dialog asked for the code, because minting
  // one invalidates the session's previous one and an effect is not a promise that it runs once.
  if (!code) {
    return <Text fz="sm" c="dimmed">Requesting a code…</Text>;
  }

  return (
    <Stack gap="md">
      <Text fz="sm" c="dimmed">Scan this with the camera device:</Text>
      <Group justify="center">
        {/* Padded in white rather than sitting on the dark panel: the quiet zone the encoder draws
            is only a quiet zone if what surrounds it is the same colour as it. */}
        <Paper radius="md" bg="white" p="xs">
          <QrCode text={pairingUrl(code.code)} size={180} />
        </Paper>
      </Group>
      <Text fz="sm" c="dimmed">
        Or open{' '}
        <CopyableText value={scorerUrl}>
          <Text span ff="monospace" c="gray.2">{scorerUrl}</Text>
        </CopyableText>
        {' '}and enter:
      </Text>
      <Text fz="2rem" ff="monospace" fw={700} c="green.4" ta="center" style={{ letterSpacing: '0.3em', userSelect: 'text' }}>
        {code.code}
      </Text>
      <Group justify="space-between" gap="sm">
        <Text fz="sm" c={remaining > 0 ? 'dimmed' : 'yellow.4'}>
          {remaining > 0 ? `Expires in ${remaining}s` : 'Expired'}
        </Text>
        <Group gap="xs">
          <Button size="compact-sm" variant="default" onClick={onRequest}>New code</Button>
          <Button size="compact-sm" variant="subtle" onClick={onCancel}>Done</Button>
        </Group>
      </Group>
    </Stack>
  );
}

/** Seconds left, ticking. Zero once it has expired. */
function useCountdown(expiresAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (!expiresAt) return 0;
  return Math.max(0, Math.round((expiresAt - now) / 1000));
}
