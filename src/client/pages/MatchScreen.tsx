import { useCallback, type ReactNode } from 'react';
import type { DartThrow, MatchState, ModePanel, ModeView, RematchAnswer } from '../../shared/types';
import { textOf } from '../../shared/types';
import { VisitInput } from '../components/VisitInput';
import { RematchPanel } from '../components/RematchPanel';
import { MatchHistory } from '../components/MatchHistory';
import { modeTextClasses } from '../components/modeText';
import { standingsOf } from '../../shared/matchFormat';
import { ModePanelBlock } from '../components/ModePanelBlock';
import type { VideoFeedId } from '../../shared/media';
import type { VideoFeedView } from '../hooks/useVideoFeed';

interface MatchScreenProps {
  match: MatchState;
  view: ModeView;
  /** The mode's own block, if it draws one. */
  panel?: ModePanel;
  onLeave: () => void;
  onAddDart: (matchId: string, dart: DartThrow) => void;
  onUndoDart: (matchId: string) => void;
  onSubmitVisit: (matchId: string) => void;
  onVoteRematch: (playerId: string, answer: RematchAnswer | 'neutral') => void;
  ownPlayerIds: string[];
  isSpectator: boolean;
  /** A photograph per dart slot from the board camera, or null where no camera is in play. */
  evidence: (string | undefined)[] | null;
  /** The fresh current player's remote board feed, or null for the virtual-board fallback. */
  liveFeed: VideoFeedView | null;
  videoOffers: readonly VideoFeedView[];
  onAcceptVideo: (feedId: VideoFeedId) => void;
  onDeclineVideo: (feedId: VideoFeedId) => void;
}

/**
 * The columns a match is played in, widest first.
 *
 * One column on a phone, which is the layout this screen has always had and the order the regions
 * are written in below. From `lg` the board sits beside the scores. From `xl` there is room for the
 * visit history as well, and that is the only width at which it appears at all.
 *
 * Fractions, not fixed widths: the columns take whatever the window gives them, the way the board
 * already did in a single column. The board gets the larger share because it is the thing worth
 * growing; each `minmax` floor is what that region needs before the layout should have collapsed to
 * fewer columns at all.
 *
 * Two rows: the scores take what they need and the second takes the rest (`minmax(0,1fr)`), which is
 * what gives the board — spanning both — a definite height to grow into. Left to `auto` the row
 * would be as tall as its own contents and the board would stop at whatever the scoreboard beside it
 * happened to need.
 *
 * The regions are written below in the order a single column wants them: scores, then the board you
 * are throwing at, then the mode's panel. Every other width places them explicitly, because that
 * order is not the one the columns want — the panel belongs under the scores, which is the cell
 * auto-placement would not choose for the third thing in the list.
 */
const PLAY_COLUMNS =
  'grid w-full gap-2 grid-cols-1 items-start lg:items-stretch lg:h-full lg:grid-rows-[auto_minmax(0,1fr)] ' +
  'lg:grid-cols-[minmax(18rem,1fr)_minmax(20rem,1.6fr)] ' +
  'xl:grid-cols-[minmax(18rem,1fr)_minmax(20rem,1.8fr)_minmax(15rem,1fr)]';

/** Where each region sits once there is more than one column. In one column, source order decides. */
const CELL = {
  scores: 'lg:col-start-1 lg:row-start-1',
  board: 'lg:col-start-2 lg:row-start-1 lg:row-span-2',
  panel: 'lg:col-start-1 lg:row-start-2',
  history: 'xl:col-start-3 xl:row-start-1 xl:row-span-2',
};

/** The summary has two regions rather than three: how it ended, and how it got there. */
const SUMMARY_COLUMNS =
  'grid w-full items-start justify-center gap-8 grid-cols-1 ' +
  'lg:grid-cols-[minmax(18rem,26rem)_minmax(15rem,22rem)]';

/**
 * Rows of visit history, always drawn — blank ones included.
 *
 * The history exists only where there is a third column to put it in. Below that it is the first
 * thing to cost more room than it earns: it is not needed to play, and what it says about the leg
 * the mode's own panel mostly says already, in less space. So it is not a smaller history on a
 * phone — it is no history, and the panel carries that weight.
 *
 * Where it is drawn, it is drawn whole: the empty rows are there from the first dart, because this
 * is the one region whose content arrives over the course of a leg and would otherwise push the
 * column around as visits land.
 */
const HISTORY_ROWS = 12;

/**
 * The match screen: universal chrome only.
 *
 * Every mode-specific value — the headline, what is on a player's card, the visit total, the history
 * lines — arrives in `view`, computed by the game mode on the server. Nothing here knows what a bust
 * or a checkout is, and adding a game mode does not change this file.
 */
export function MatchScreen({ match, view, panel, onLeave, onAddDart, onUndoDart, onSubmitVisit, onVoteRematch, ownPlayerIds, isSpectator, evidence, liveFeed, videoOffers, onAcceptVideo, onDeclineVideo }: MatchScreenProps) {
  const currentPlayer = match.players[match.currentPlayerIndex];
  const isMyTurn = !isSpectator && match.status === 'in_progress' && (ownPlayerIds.length === 0 || ownPlayerIds.includes(currentPlayer.id));

  const currentDarts = match.currentVisit?.darts ?? [];
  const visitLocked = match.currentVisit?.locked ?? false;
  const canAddDart = isMyTurn && !visitLocked && currentDarts.length < view.dartsPerVisit && match.status === 'in_progress';

  const handleAddDart = useCallback((dart: DartThrow) => {
    onAddDart(match.id, dart);
  }, [match.id, onAddDart]);

  const handleUndo = useCallback(() => {
    onUndoDart(match.id);
  }, [match.id, onUndoDart]);

  const handleSubmit = useCallback(() => {
    onSubmitVisit(match.id);
  }, [match.id, onSubmitVisit]);

  const over = match.status === 'finished';
  const liveBoard = liveFeed?.canvas ? {
    canvas: liveFeed.canvas,
    ...(liveFeed.label ? { label: liveFeed.label } : {}),
  } : null;

  return (
    // From `lg` this screen is exactly as tall as what it was given and never scrolls: the columns
    // inside divide that height up, and the board grows into whatever is left.
    <div className="flex-1 flex flex-col items-center gap-2 p-2 lg:min-h-0 lg:overflow-hidden">
      <div className="w-full flex items-center justify-between gap-3 ">
        <h2 className={`${modeTextClasses(view.headline, { tone: 'accent', size: '2xl', weight: 'bold' })} min-w-0`}>
          {textOf(view.headline)}
          {isSpectator && <span className="text-yellow-400 text-base ml-2">(spectating)</span>}
        </h2>

        <button
          onClick={onLeave}
          className="shrink-0 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
        >
          {over ? 'Exit' : 'Leave Match'}
        </button>
      </div>

      {over ? (
        <Stage>
          <Summary match={match} isSpectator={isSpectator} ownPlayerIds={ownPlayerIds} onVote={onVoteRematch} />
        </Stage>
      ) : (
        <Stage>
          <div className={PLAY_COLUMNS}>
            {/* Regions that are only as tall as the window scroll within themselves rather than
                push the layout past it. In practice none of them fills the height. */}
            <section className={`flex flex-col items-center gap-2 lg:min-h-0 lg:overflow-y-auto ${CELL.scores}`}>
              <PlayerCards match={match} scores={view.playerScores} />
            </section>

            <section className={`flex flex-col items-center gap-2 lg:min-h-0 ${CELL.board}`}>
              {view.notice && isMyTurn && (
                <p className={modeTextClasses(view.notice, { tone: 'warning', weight: 'semibold' })}>
                  {textOf(view.notice)}
                </p>
              )}
              <VisitInput
                evidence={evidence}
                darts={currentDarts}
                dartsPerVisit={view.dartsPerVisit}
                slots={view.slots}
                visitTotal={view.visitTotal}
                onAddDart={isSpectator ? () => {} : handleAddDart}
                onUndoDart={isSpectator ? () => {} : handleUndo}
                onSubmit={isSpectator ? () => {} : handleSubmit}
                disabled={!canAddDart}
                locked={visitLocked}
                readOnly={!isMyTurn || isSpectator}
                hideActions={isSpectator}
                liveBoard={liveBoard}
                videoOffers={videoOffers}
                onAcceptVideo={onAcceptVideo}
                onDeclineVideo={onDeclineVideo}
              />
            </section>

            {/* The mode's own block. Nothing is rendered for a mode that draws none.
                Under the scores wherever there is a column for it, and under the board when there
                is not: on a phone the thing being aimed at comes before the reading about it. */}
            {panel && (
              <section className={`flex flex-col items-center lg:min-h-0 lg:overflow-y-auto ${CELL.panel}`}>
                <ModePanelBlock modeId={match.settings.mode} panel={panel} />
              </section>
            )}

            {/* Only ever the third column — see HISTORY_ROWS. */}
            <section className={`hidden xl:block w-full xl:min-h-0 xl:overflow-y-auto ${CELL.history}`}>
              <h3 className="text-gray-400 text-sm uppercase mb-2">Visit History</h3>
              {Array.from({ length: HISTORY_ROWS }).map((_, i) => {
                const line = view.history[i];
                return (
                  <div
                    key={i}
                    className={modeTextClasses(line ?? '', { size: 'sm' }, 'py-1 px-2 font-mono whitespace-pre-wrap')}
                  >
                    {/* A blank row still has to be a row's worth of height. */}
                    {line ? textOf(line) : ' '}
                  </div>
                );
              })}
            </section>
          </div>
        </Stage>
      )}

    </div>
  );
}

/**
 * The middle of the screen: everything between the headline and the button that leaves.
 *
 * A surface of its own, a shade off the page, so that the part which rearranges itself into columns
 * reads as one region however many columns it currently has — including the one-column case, where
 * there is otherwise nothing to say where it begins and ends.
 */
function Stage({ children }: { children: ReactNode }) {
  return (
    <div className="w-full lg:max-w-none lg:flex-1 lg:min-h-0 rounded-2xl bg-gray-900/40 p-4 sm:p-2">
      {children}
    </div>
  );
}

/**
 * How the match ended, and how it got there.
 *
 * Match-driven throughout: the verdict, the scoreline and the re-match question mean the same thing
 * whatever was played inside the legs, which is why no part of this asks the game mode anything.
 */
function Summary({
  match,
  isSpectator,
  ownPlayerIds,
  onVote,
}: {
  match: MatchState;
  isSpectator: boolean;
  ownPlayerIds: string[];
  onVote: (playerId: string, answer: RematchAnswer | 'neutral') => void;
}) {
  return (
    // The summary is short and the stage it sits in is as tall as the window, so it is centred in
    // it rather than pinned to the top of a mostly empty box.
    <div className="w-full flex flex-col items-center gap-2 lg:h-full lg:justify-center">
      {/* No winner on a finished match means it was cancelled, not won. */}
      {match.winnerId ? (
        <p className="text-2xl text-yellow-400 font-bold text-center">
          🎯 {match.players.find((p) => p.id === match.winnerId)?.name ?? 'Unknown'} wins!
        </p>
      ) : (
        <p className="text-2xl text-gray-400 font-bold text-center">Match cancelled</p>
      )}

      <div className={SUMMARY_COLUMNS}>
        <section className="flex justify-center">
          <PlayerCards match={match} />
        </section>

        <section className="flex flex-col items-center">
          <h3 className="text-gray-400 text-sm uppercase mb-2">Match History</h3>
          <MatchHistory match={match} />
        </section>
      </div>

      {!isSpectator && <RematchPanel match={match} ownPlayerIds={ownPlayerIds} onVote={onVote} />}
    </div>
  );
}

/**
 * The score panel. While the match is on it is the mode's; once it is over it is the result.
 *
 * Wraps rather than overflows, because this is the one row that has to hold on a narrow phone as
 * well as in a column of its own, and the cards share out whatever width that column has — the
 * board beside them grows with the window, and cards pinned to their minimum next to it would look
 * like an oversight.
 *
 * `scores` is what the mode has to say about each player and is absent once the match is over —
 * there is no score to show then, only how it ended.
 */
function PlayerCards({ match, scores }: { match: MatchState; scores?: ModeView['playerScores'] }) {
  const over = match.status === 'finished';
  const standings = standingsOf(match.legs, match.settings);

  return (
    <div className="flex flex-wrap justify-center gap-2 sm:gap-8 w-full">
      {match.players.map((player, i) => {
        const isCurrent = !over && i === match.currentPlayerIndex;
        const isDeparted = match.departed.includes(player.id);
        const score = scores?.[player.id] ?? '';
        return (
          <div
            key={player.id}
            data-player={player.name}
            aria-current={isCurrent}
            className={`text-center px-4 py-2 rounded-lg flex-1 min-w-[120px] max-w-[16rem] ${
              isDeparted
                ? 'bg-gray-900/50 opacity-60 border border-red-900/50'
                : isCurrent
                  ? 'bg-green-900 border border-green-500'
                  : 'bg-gray-900'
            }`}
          >
            <p className="text-sm text-gray-400">{player.name}</p>

            {over ? (
              <Verdict match={match} playerId={player.id} />
            ) : (
              <>
                <p className="text-xs text-gray-500 font-mono">
                  {formatStandings(
                    standings.setWins[player.id] ?? 0,
                    standings.legWins[player.id] ?? 0,
                    match.settings.legsToWinSet,
                  )}
                </p>
                {/* Whose turn it is is ours to colour; anything the mode wants to say about the
                    score itself overrides it. */}
                <p
                  className={modeTextClasses(
                    score,
                    { tone: isCurrent ? 'accent' : 'default', size: '4xl', weight: 'bold' },
                    'font-mono',
                  )}
                >
                  {textOf(score)}
                </p>
                {isDeparted ? (
                  <p className="text-xs text-red-400 mt-1">departed</p>
                ) : isCurrent ? (
                  <p className="text-xs text-green-500 mt-1">▶ throwing</p>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Where a player stands: sets won, and legs won in the set being played.
 *
 * Single-leg sets are a set per leg, so showing both would read as "3S | 0L" for someone who has won
 * three. In that one case the set count is shown as legs — a display choice only; the match is sets
 * and legs underneath either way.
 */
function formatStandings(setWins: number, legWins: number, legsToWinSet: number): string {
  return legsToWinSet === 1 ? `${setWins}L` : `${setWins}S | ${legWins}L`;
}

/**
 * How a player finished. A cancelled match has no winner and therefore no verdict to give.
 */
function Verdict({ match, playerId }: { match: MatchState; playerId: string }) {
  if (match.departed.includes(playerId)) return <p className="text-2xl font-bold text-red-400">left</p>;
  if (!match.winnerId) return <p className="text-2xl font-bold text-gray-600">—</p>;
  return match.winnerId === playerId
    ? <p className="text-2xl font-bold text-green-400">WINNER</p>
    : <p className="text-2xl font-bold text-gray-500">loser</p>;
}
