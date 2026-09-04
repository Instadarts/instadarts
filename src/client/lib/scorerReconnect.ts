/** What a fresh scorer_state means relative to what this phone knew before it arrived. */
export type ScoringActivationKind = 'started' | 'resumed';

/** Numbered because two activations of the same kind are still two events. */
export interface ScoringActivation {
  kind: ScoringActivationKind;
  seq: number;
}

/**
 * Classify an active scoring context without mistaking a socket reconnect for a new match.
 *
 * `reconnecting` is true only for the first authoritative state on a replacement socket. Later
 * states are ordinary live transitions, where leaving and re-entering even the same context is a
 * start from the device's point of view.
 */
export function classifyScoringActivation(
  previousContextId: string | null,
  nextContextId: string | null,
  reconnecting: boolean,
): ScoringActivationKind | null {
  if (nextContextId === null) return null;
  if (reconnecting && nextContextId === previousContextId) return 'resumed';
  return nextContextId !== previousContextId ? 'started' : null;
}
