import { Code, Group, Stack, Text } from '@mantine/core';
import { CopyableText } from './CopyableText';

interface InvitePanelProps {
  inviteCode: string | null;
  userCount: number;
  maxPlayers: number;
  isClosed: boolean;
}

export function InvitePanel({ inviteCode, userCount, maxPlayers, isClosed }: InvitePanelProps) {
  if (isClosed) {
    const oneOnOne = maxPlayers <= 2 && userCount >= 2;
    return <Text c="var(--instadarts-accent)" fw={700}>{oneOnOne ? '✓ Opponent connected' : '✓ Lobby is full'}</Text>;
  }

  if (!inviteCode) return null;
  const inviteUrl = `${window.location.origin}/lobby/join/${inviteCode}`;

  return (
    <Stack align="center" gap="sm" ta="center">
      {userCount > 1 && (
        <Text c="var(--instadarts-accent)" fw={700} fz="sm">
          {`✓ ${userCount - 1} other ${userCount === 2 ? 'user' : 'users'} connected`}
        </Text>
      )}
      <Text c="dimmed" fz="sm">Invite Code</Text>
      <CopyableText value={inviteCode}>
        <Group gap="xs" wrap="nowrap">
          <Code fz="xl" c="var(--instadarts-accent)" px="md" py="xs" style={{ letterSpacing: '0.18em' }}>{inviteCode}</Code>
          <Text component="span" fz="xl" aria-hidden>📋</Text>
        </Group>
      </CopyableText>
      <Text c="dimmed" fz="xs" style={{ overflowWrap: 'anywhere' }}>
        Or share:{' '}
        <CopyableText value={inviteUrl}>
          <Text span c="var(--instadarts-link)">/lobby/join/{inviteCode}</Text>
        </CopyableText>
      </Text>
    </Stack>
  );
}
