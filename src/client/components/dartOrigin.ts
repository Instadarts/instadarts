import type { DartThrow } from '../../shared/types';

/**
 * Where a dart came from, in one line: the scorer that placed it and how many scorers saw it, of
 * those that reported in its throw window, of the most that were active while the window was open.
 */
export function dartOrigin(dart: DartThrow): string {
  if (!dart.detection) return 'Manually added';
  const { winningScorer, contributingScorers, reportingScorers, expectedScorers } = dart.detection;
  return `Detected by ${winningScorer || 'an unnamed scorer'} (${contributingScorers}/${reportingScorers}/${expectedScorers})`;
}
