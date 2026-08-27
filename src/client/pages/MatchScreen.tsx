import { useCallback, useEffect, useRef } from 'react';
import { Badge, Button, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import type { DartThrow, MatchState, ModePanel, ModeView, RematchAnswer } from '../../shared/types';
import { textOf, toneOf } from '../../shared/types';
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
  LIVE_MATCH_LAYOUTS,
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

  useAutoSubmit({
    enabled: Boolean(view.autoSubmit) && isMyTurn,
    // A visit has no id of its own — it does not exist until a dart lands, and this one never gets
    // any. The count of committed visits is what numbers it, and it ticks the moment this submit
    // lands, so the guard cannot fire twice for the same turn or miss the next one.
    visitKey: `${match.id}:${match.visits.length}`,
    onSubmit: handleSubmit,
  });
  const { c: headlineColor, fw: headlineWeight } = modeTextProps(view.headline, {
    tone: 'accent',
    weight: 'bold',
  });
  const liveBoard = liveFeed?.canvas ? {
    canvas: liveFeed.canvas,
    ...(liveFeed.label ? { label: liveFeed.label } : {}),
  } : null;

  const overview = (
    <GridBox title="Overview" editable={true}>
      <Group justify="space-between" gap="md" wrap="nowrap">
        {/* nowrap, because the card is four rows tall and clips: a badge pushed to a second line is
            not a smaller layout, it is a badge nobody sees. Everything here shrinks instead — the
            headline fits itself, a badge truncates. */}
        <Group className="match-overview__headline-group" gap="sm" miw={0} wrap="nowrap">
          <AutoFitText
            color={headlineColor}
            component="h2"
            fitHeight={false}
            fontFamily="var(--mantine-font-family-headings)"
            fontWeight={headlineWeight}
            horizontalAlign="start"
            lineHeight={1}
            maximumFontSize={36}
            minimumFontSize={16}
            text={textOf(view.headline)}
          />
          {isSpectator && <Badge color="yellow">spectating</Badge>}
        </Group>
        <Button variant="default" onClick={onLeave}>{over ? 'Exit' : 'Leave'}</Button>
      </Group>
    </GridBox>
  );

  if (over) {
    const items: ResponsiveBoxItem[] = [
      { id: 'overview', defaultTitleBarVisible: false, content: overview },
      {
        id: 'result',
        content: (
          <GridBox title="Result">
            <Stack gap="lg" align="stretch">
              {match.winnerId ? (
                <Text fz="xl" c="var(--instadarts-tone-warning-fg)" fw={700} ta="center">
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
    if (!isSpectator && match.departed.length === 0) {
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
        defaultLayouts={SUMMARY_MATCH_LAYOUTS}
        items={items}
      />
    );
  }

  const items: ResponsiveBoxItem[] = [
    { id: 'overview', defaultTitleBarVisible: false, content: overview },
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
    {
      id: 'history',
      optional: { label: 'Visit history', defaultEnabled: false },
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
    },
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
      defaultLayouts={LIVE_MATCH_LAYOUTS}
      items={items}
    />
  );
}

/**
 * How long a skipped turn stays on screen before it is submitted.
 *
 * Not zero. A turn that vanishes the instant it arrives reads as a dropped frame rather than as a
 * turn, and the player it belonged to never sees why they got nothing to throw — which for
 * Whac-A-Mole is the whole story of the darts they lost. Long enough to register, short enough that
 * nobody waits on it.
 */
const AUTO_SUBMIT_MS = 1400;

/**
 * Submit a visit the mode says is empty, once, for the player whose turn it is.
 *
 * Only that player's own client runs this — everyone else is watching a turn taken elsewhere, and a
 * second submit would be a second turn. The timer is cleared if anything moves first, so a state
 * that arrives mid-wait cannot land a submit for a turn that has already gone.
 */
function useAutoSubmit({
  enabled,
  visitKey,
  onSubmit,
}: {
  enabled: boolean;
  visitKey: string;
  onSubmit: () => void;
}) {
  const submitted = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || submitted.current === visitKey) return;
    const timer = setTimeout(() => {
      submitted.current = visitKey;
      onSubmit();
    }, AUTO_SUBMIT_MS);
    return () => clearTimeout(timer);
  }, [enabled, visitKey, onSubmit]);
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
        // Three states, three surfaces: the player throwing is lit, the ones waiting sit in the
        // card, and somebody who has left is sunk into it.
        const background = isDeparted
          ? 'var(--instadarts-surface-sunken)'
          : isCurrent ? 'var(--instadarts-tone-accent-bg)' : 'var(--instadarts-surface-raised)';
        const borderColor = isDeparted
          ? 'var(--instadarts-tone-danger-fg)'
          : isCurrent ? 'var(--instadarts-accent)' : undefined;
        const scoreTone = toneOf(score) ?? (isCurrent ? 'warning' : 'muted');
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
            <Text fz="h1" lh="1em" truncate>{player.name}</Text>
            {over ? (
              <Verdict match={match} playerId={player.id} />
            ) : (
              <>
                <Text fz="xs" ff="monospace">
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
                  style={{ textShadow: 'var(--instadarts-score-glow)' }}
                />
                {isDeparted ? (
                  <Text fz="xs" c="var(--instadarts-tone-danger-fg)">departed</Text>
                ) : isCurrent ? (
                  <Text fz="xs" c="var(--instadarts-tone-positive-fg)">▶ throwing</Text>
                ) : <Text fz="xs" c="dimmed">waiting</Text>}
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
  if (match.departed.includes(playerId)) return <Text fz="xl" fw={700} c="var(--instadarts-tone-danger-fg)">left</Text>;
  if (!match.winnerId) return <Text fz="xl" fw={700} c="dimmed">—</Text>;
  return match.winnerId === playerId
    ? <Text fz="xl" fw={700} c="var(--instadarts-accent)">WINNER</Text>
    : <Text fz="xl" fw={700} c="dimmed">loser</Text>;
}
