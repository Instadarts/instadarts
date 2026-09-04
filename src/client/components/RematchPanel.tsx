import { useEffect, useState } from 'react';
import { Button, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import type { MatchState, RematchAnswer } from '../../shared/types';

interface RematchPanelProps {
  match: MatchState;
  ownPlayerIds: string[];
  onVote: (playerId: string, answer: RematchAnswer | 'neutral') => void;
}

export function RematchPanel({ match, ownPlayerIds, onVote }: RematchPanelProps) {
  const declined = match.players.some((player) => match.rematchVotes[player.id] === 'declined');
  return (
    <Stack align="center" gap="md" w="100%">
      <Text c="dimmed" fz="sm" tt="uppercase">{declined ? 'No re-match' : 'Play again?'}</Text>
      <SimpleGrid minColWidth={180} autoFlow="auto-fit" spacing="md" w="100%">
        {match.players.map((player) => (
          <PlayerVote
            key={player.id}
            name={player.name}
            answer={match.rematchVotes[player.id]}
            canAnswer={!declined && !match.departed.includes(player.id) && ownPlayerIds.includes(player.id)}
            onVote={(answer) => onVote(player.id, answer)}
          />
        ))}
      </SimpleGrid>
      <Countdown until={match.expiresAt} declined={declined} />
    </Stack>
  );
}

function PlayerVote({
  name,
  answer,
  canAnswer,
  onVote,
}: {
  name: string;
  answer: RematchAnswer | undefined;
  canAnswer: boolean;
  onVote: (answer: RematchAnswer | 'neutral') => void;
}) {
  const press = (next: RematchAnswer) => onVote(answer === next ? 'neutral' : next);
  return (
    <Stack align="center" gap="xs">
      <Text fw={600}>{name}</Text>
      <Group gap="xs" wrap="nowrap">
        <VoteButton label="✓ Yes" ariaLabel={`${name}: accept re-match`} color="green" active={answer === 'accepted'} disabled={!canAnswer} onClick={() => press('accepted')} />
        <VoteButton label="✕ No" ariaLabel={`${name}: decline re-match`} color="red" active={answer === 'declined'} disabled={!canAnswer} onClick={() => press('declined')} />
      </Group>
    </Stack>
  );
}

function VoteButton({
  label,
  ariaLabel,
  color,
  active,
  disabled,
  onClick,
}: {
  label: string;
  ariaLabel: string;
  color: 'green' | 'red';
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? 'filled' : 'outline'}
      color={color}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

function Countdown({ until, declined }: { until: number; declined: boolean }) {
  const [remaining, setRemaining] = useState(() => until - Date.now());
  useEffect(() => {
    setRemaining(until - Date.now());
    const timer = setInterval(() => setRemaining(until - Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);

  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <Text c="dimmed" fz="sm">{declined ? `Closing in ${clock}` : `No answer counts as no, in ${clock}`}</Text>;
}
