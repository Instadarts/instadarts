import { useCallback } from 'react';
import { Badge, Button, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import type { DartThrow, MatchState, ModePanel, ModeView, RematchAnswer } from '../../shared/types';
import { styleOf, textOf } from '../../shared/types';
import { standingsOf } from '../../shared/matchFormat';
import type { VideoFeedId } from '../../shared/media';
import type { VideoFeedView } from '../hooks/useVideoFeed';
import { VisitInput } from '../components/VisitInput';
import { VirtualBoard } from '../components/VirtualBoard';
import { RematchPanel } from '../components/RematchPanel';
import { MatchHistory } from '../components/MatchHistory';
import { modeTextProps } from '../components/modeText';
import { ModePanelBlock } from '../components/ModePanelBlock';
import { AutoFitText } from '../components/AutoFitText';
import { GridBox } from '../layout/GridBox';
import { ResponsiveBoxGrid, type ResponsiveBoxItem } from '../layout/ResponsiveBoxGrid';
import {
  LIVE_MATCH_LAYOUT,
  LIVE_MATCH_LAYOUTS,
  SUMMARY_MATCH_LAYOUT,
  SUMMARY_MATCH_LAYOUTS,
} from '../layout/frontendLayout';

interface MatchScreenProps {
  match: MatchState;
  view: ModeView;
  panel?: ModePanel;
  onLeave: () => void;
  onAddDart: (matchId: string, dart: DartThrow) => void;
  onUndoDart: (matchId: string) => void;
  onSubmitVisit: (matchId: string) => void;
  onVoteRematch: (playerId: string, answer: RematchAnswer | 'neutral') => void;
  ownPlayerIds: string[];
  isSpectator: boolean;
  mediaDisabled: boolean;
  evidence: (string | undefined)[] | null;
  liveFeed: VideoFeedView | null;
  videoOffers: readonly VideoFeedView[];
  onAcceptVideo: (feedId: VideoFeedId) => void;
  onDeclineVideo: (feedId: VideoFeedId) => void;
}

const HISTORY_ROWS = 12;

export function MatchScreen({
  match,
  view,
  panel,
  onLeave,
  onAddDart,
  onUndoDart,
  onSubmitVisit,
  onVoteRematch,
  ownPlayerIds,
  isSpectator,
  mediaDisabled,
  evidence,
  liveFeed,
  videoOffers,
  onAcceptVideo,
  onDeclineVideo,
}: MatchScreenProps) {
  const currentPlayer = match.players[match.currentPlayerIndex];
  const isMyTurn = !isSpectator && match.status === 'in_progress' && ownPlayerIds.includes(currentPlayer.id);
  const currentDarts = match.currentVisit?.darts ?? [];
  const visitLocked = match.currentVisit?.locked ?? false;
  const canAddDart = isMyTurn && !visitLocked && currentDarts.length < view.dartsPerVisit && match.status === 'in_progress';

  const handleAddDart = useCallback((dart: DartThrow) => onAddDart(match.id, dart), [match.id, onAddDart]);
  const handleUndo = useCallback(() => onUndoDart(match.id), [match.id, onUndoDart]);
  const handleSubmit = useCallback(() => onSubmitVisit(match.id), [match.id, onSubmitVisit]);
  const over = match.status === 'finished';
  const liveBoard = liveFeed?.canvas ? {
    canvas: liveFeed.canvas,
    ...(liveFeed.label ? { label: liveFeed.label } : {}),
  } : null;

  const overview = (
    <GridBox editable={false}>
      <Group justify="space-between" gap="md" wrap="wrap">
        <Group gap="sm" miw={0}>
          <Title order={2} style={{"line-height": "1em"}} {...modeTextProps(view.headline, { tone: 'accent', size: '4xl', weight: 'bold' })}>
            {textOf(view.headline)}
          </Title>
          {isSpectator && <Badge color="yellow">spectating</Badge>}
          {mediaDisabled && !over && <Badge variant="light" color="gray">video off · more than two boards</Badge>}
        </Group>
        <Button variant="default" onClick={onLeave}>{over ? 'Exit' : 'Leave Match'}</Button>
      </Group>
    </GridBox>
  );

  if (over) {
    const items: ResponsiveBoxItem[] = [
      { id: 'overview', content: overview },
      {
        id: 'result',
        content: (
          <GridBox title="Result">
            <Stack gap="lg" align="stretch">
              {match.winnerId ? (
                <Text fz="xl" c="yellow.4" fw={700} ta="center">
                  🎯 {match.players.find((player) => player.id === match.winnerId)?.name ?? 'Unknown'} wins!
                </Text>
              ) : (
                <Text fz="xl" c="dimmed" fw={700} ta="center">Match cancelled</Text>
              )}
              <PlayerCards match={match} />
            </Stack>
          </GridBox>
        ),
      },
      {
        id: 'match-history',
        content: <GridBox title="Match history"><MatchHistory match={match} /></GridBox>,
      },
    ];
    if (!isSpectator) {
      items.push({
        id: 'rematch',
        content: (
          <GridBox title="Play again?" centered>
            <RematchPanel match={match} ownPlayerIds={ownPlayerIds} onVote={onVoteRematch} />
          </GridBox>
        ),
      });
    }

    return (
      <ResponsiveBoxGrid
        key="match-summary"
        profile="match-summary"
        defaultLayout={SUMMARY_MATCH_LAYOUT}
        defaultLayouts={SUMMARY_MATCH_LAYOUTS}
        items={items}
      />
    );
  }

  const items: ResponsiveBoxItem[] = [
    { id: 'overview', content: overview },
    { id: 'scores', content: <GridBox title="Scores"><PlayerCards match={match} scores={view.playerScores} /></GridBox> },
    {
      id: 'board',
      content: (
        <GridBox title="Board" padding="sm">
          <VirtualBoard
            darts={currentDarts}
            dartsPerVisit={view.dartsPerVisit}
            onAddDart={isSpectator ? () => {} : handleAddDart}
            disabled={!canAddDart}
            liveBoard={liveBoard}
            videoOffers={videoOffers}
            onAcceptVideo={onAcceptVideo}
            onDeclineVideo={onDeclineVideo}
          />
        </GridBox>
      ),
    },
    {
      id: 'visit',
      content: (
        <GridBox
          title="Visit"
          padding="sm"
          headerCenter={view.notice ? (
            <Text
              ta="center"
              lh={1}
              tt="uppercase"
              truncate
              {...modeTextProps(view.notice, { tone: 'warning', weight: 'semibold' })}
            >
              {textOf(view.notice)}
            </Text>
          ) : undefined}
        >
          <VisitInput
            evidence={evidence}
            darts={currentDarts}
            dartsPerVisit={view.dartsPerVisit}
            slots={view.slots}
            visitTotal={view.visitTotal}
            onUndoDart={isSpectator ? () => {} : handleUndo}
            onSubmit={isSpectator ? () => {} : handleSubmit}
            readOnly={!isMyTurn || isSpectator}
            hideActions={isSpectator}
          />
        </GridBox>
      ),
    },
    /** currently disabled, do not remove *{
      id: 'history',
      content: (
        <GridBox title="Visit history">
          <Stack gap={0}>
            {Array.from({ length: HISTORY_ROWS }).map((_, index) => {
              const line = view.history[index];
              return (
                <Text
                  key={index}
                  ff="monospace"
                  py={4}
                  px="xs"
                  style={{ whiteSpace: 'pre-wrap' }}
                  {...modeTextProps(line ?? '', { size: 'sm' })}
                >
                  {line ? textOf(line) : ' '}
                </Text>
              );
            })}
          </Stack>
        </GridBox>
      ),
    },**/
  ];

  if (panel) {
    items.push({
      id: 'mode-panel',
      content: (
        <GridBox title={panel.title?.trim() || 'Game panel'}>
          <ModePanelBlock modeId={match.settings.mode} panel={panel} />
        </GridBox>
      ),
    });
  }

  return (
    <ResponsiveBoxGrid
      key="match-live"
      profile="match-live"
      defaultLayout={LIVE_MATCH_LAYOUT}
      defaultLayouts={LIVE_MATCH_LAYOUTS}
      items={items}
    />
  );
}

function PlayerCards({ match, scores }: { match: MatchState; scores?: ModeView['playerScores'] }) {
  const over = match.status === 'finished';
  const standings = standingsOf(match.legs, match.settings);

  return (
    <SimpleGrid minColWidth={120} autoFlow="auto-fit" spacing="sm" h={over ? undefined : '100%'}>
      {match.players.map((player, index) => {
        const isCurrent = !over && index === match.currentPlayerIndex;
        const isDeparted = match.departed.includes(player.id);
        const score = scores?.[player.id] ?? '';
        const background = isDeparted ? 'dark.8' : isCurrent ? 'green.9' : 'dark.7';
        const borderColor = isDeparted ? 'var(--mantine-color-red-9)' : isCurrent ? 'var(--mantine-color-green-5)' : undefined;
        const scoreTone = styleOf(score).tone ?? (isCurrent ? 'warning' : 'muted');
        const scoreStyle = modeTextProps(undefined, { tone: scoreTone, weight: 'bold' });

        return (
          <Paper
            key={player.id}
            data-player={player.name}
            aria-current={isCurrent}
            p="xs"
            radius="md"
            bg={background}
            withBorder
            style={{
              borderColor,
              display: 'flex',
              flexDirection: 'column',
              opacity: isDeparted ? 0.6 : 1,
              textAlign: 'center',
            }}
          >
            <Text fz="h1" lh="1em" c="gray.3" truncate>{player.name}</Text>
            {over ? (
              <Verdict match={match} playerId={player.id} />
            ) : (
              <>
                <Text fz="xs" c="gray.3" ff="monospace">
                  {formatStandings(
                    standings.setWins[player.id] ?? 0,
                    standings.legWins[player.id] ?? 0,
                    match.settings.legsToWinSet,
                  )}
                </Text>
                <AutoFitText
                  text={textOf(score)}
                  color={scoreStyle.c}
                  fontFamily="monospace"
                  fontWeight={scoreStyle.fw}
                  lineHeight={1.2}
                  style={{ textShadow: '0 0 5px black' }}
                />
                {isDeparted ? (
                  <Text fz="xs" c="red.4">departed</Text>
                ) : isCurrent ? (
                  <Text fz="xs" c="green.2">▶ throwing</Text>
                ) : <Text fz="xs" c="gray.6">waiting</Text>}
              </>
            )}
          </Paper>
        );
      })}
    </SimpleGrid>
  );
}

function formatStandings(setWins: number, legWins: number, legsToWinSet: number): string {
  return legsToWinSet === 1 ? `${setWins}L` : `${setWins}S | ${legWins}L`;
}

function Verdict({ match, playerId }: { match: MatchState; playerId: string }) {
  if (match.departed.includes(playerId)) return <Text fz="xl" fw={700} c="red.4">left</Text>;
  if (!match.winnerId) return <Text fz="xl" fw={700} c="gray.6">—</Text>;
  return match.winnerId === playerId
    ? <Text fz="xl" fw={700} c="green.4">WINNER</Text>
    : <Text fz="xl" fw={700} c="gray.6">loser</Text>;
}
