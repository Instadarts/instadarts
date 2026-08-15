import { useEffect, useRef, useState } from 'react';
import type { MediaMesh } from './useMediaMesh';
import type { MeshLink } from '../media/mesh';

export function setupSnapshotSettled(captured: readonly string[], links: readonly MeshLink[]): boolean {
  return captured.every((peerId) => {
    const link = links.find((candidate) => candidate.peer.peerId === peerId);
    return !link || link.ready || link.state === 'failed' || link.state === 'closed';
  });
}

/**
 * Presentation-only match entry gate. It never changes server/game state and deliberately records
 * completed match ids so an in-place socket or ICE recovery cannot bring the full-screen gate back.
 */
export function useMatchMediaSetup(
  matchId: string | null,
  mediaEnabled: boolean | null,
  timeoutMs: number,
  session: MediaMesh['session'],
  links: readonly MeshLink[],
): boolean {
  const completed = useRef(new Set<string>());
  const [entry, setEntry] = useState<{ matchId: string; captured: string[] | null } | null>(null);

  useEffect(() => {
    if (!matchId || completed.current.has(matchId)) {
      setEntry(null);
      return;
    }
    if (mediaEnabled === false) {
      completed.current.add(matchId);
      setEntry(null);
      return;
    }
    setEntry({ matchId, captured: null });
    const timer = setTimeout(() => {
      completed.current.add(matchId);
      setEntry((current) => current?.matchId === matchId ? null : current);
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [matchId, mediaEnabled, timeoutMs]);

  useEffect(() => {
    if (!entry || entry.matchId !== matchId || entry.captured !== null) return;
    if (!session || session.matchId !== entry.matchId || !session.setupComplete) return;
    setEntry({ matchId: entry.matchId, captured: links.map((link) => link.peer.peerId) });
  }, [entry, matchId, session, links]);

  useEffect(() => {
    if (!entry?.captured) return;
    const settled = setupSnapshotSettled(entry.captured, links);
    if (!settled) return;
    completed.current.add(entry.matchId);
    setEntry(null);
  }, [entry, links]);

  return entry !== null;
}
