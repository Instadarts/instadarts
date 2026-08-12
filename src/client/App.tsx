import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { useMatch } from './hooks/useMatch';
import { useScoringDevices } from './hooks/useScoringDevices';
import { useMediaMesh } from './hooks/useMediaMesh';
import { useDartEvidence } from './hooks/useDartEvidence';
import { useVideoFeed } from './hooks/useVideoFeed';
import { MediaDebugPanel } from './components/MediaDebugPanel';
import { overlayFor } from './components/feedOverlay';
import { loadBoardCamera, loadMediaEnabled, saveBoardCamera, saveMediaEnabled } from './lib/mediaStorage';
import { useNavigationGuard } from './hooks/useNavigationGuard';
import { HomePage } from './pages/HomePage';
import { LobbyPage } from './pages/LobbyPage';
import { MatchScreen } from './pages/MatchScreen';
import { JoinHandler } from './pages/JoinHandler';
import { TopBar } from './components/TopBar';
import { loadReconnectInfo } from './lib/ws';
import type { ServerMessage } from '../shared/protocol';
import type { ControlMessage } from '../shared/media';
import type { Lobby, MatchState, ModePanel, ModeView, RematchAnswer } from '../shared/types';
import type { ModeDescriptor } from '../shared/settings';

export function App() {
  // Scoring devices and media both share the match socket, but the socket is created inside
  // useMatch. The refs are what let them be introduced without any of them owning the other.
  const devicesHandler = useRef<((msg: ServerMessage) => void) | null>(null);
  const mediaHandler = useRef<((msg: ServerMessage) => void) | null>(null);

  const {
    lobby,
    match,
    view,
    panel,
    modes,
    error,
    notice,
    connected,
    ownPlayerId,
    isSpectator,
    isHost,
    send,
    createLobby,
    joinLobby,
    addLocalPlayer,
    removePlayer,
    updateSettings,
    startMatch,
    submitVisit,
    leaveMatch,
    spectate,
    swapPlayers,
    voteRematch,
    addDart,
    undoDart,
  } = useMatch((msg) => { devicesHandler.current?.(msg); mediaHandler.current?.(msg); });

  const devices = useScoringDevices(send, connected);
  devicesHandler.current = devices.handleMessage;

  const [wantsMedia, setWantsMedia] = useState(() => loadMediaEnabled());
  // Which of this tab's claimed devices is showing the board — to the opponent as much as to us.
  const [boardCamera, setBoardCamera] = useState(() => loadBoardCamera());
  // Whose visit is on screen — the thrower's, whoever that is. Only they may ask a camera for
  // anything; everyone else receives the same picture unasked.
  const currentPlayer = match?.players[match.currentPlayerIndex];
  const isThrower = !isSpectator && match?.status === 'in_progress'
    && (!ownPlayerId || currentPlayer?.id === ownPlayerId);

  const evidenceHandler = useRef<((from: string, message: ControlMessage, payload?: Uint8Array) => void) | null>(null);
  const feedHandler = useRef<((from: string, message: ControlMessage) => void) | null>(null);
  const feedMedia = useRef<((from: string, data: ArrayBuffer) => void) | null>(null);
  const media = useMediaMesh(send, connected, {
    tier: wantsMedia ? 'video' : 'disabled',
    boardCamera,
    onControl: (from, message, payload) => {
      evidenceHandler.current?.(from, message, payload);
      feedHandler.current?.(from, message);
    },
    onMedia: (from, data) => feedMedia.current?.(from, data),
  });
  mediaHandler.current = media.handleMessage;

  // The live board. Asked for in the lobby and only under `?e2e=1` — the feed is being proven rather
  // than shipped, and the diagnostics panel is the only place it is rendered.
  const feed = useVideoFeed({
    mesh: media.mesh,
    config: media.config,
    links: media.links,
    inRoom: Boolean(lobby || match),
  });
  feedHandler.current = feed.handleControl;
  feedMedia.current = feed.handleMedia;

  const evidence = useDartEvidence({
    mesh: media.mesh,
    currentVisit: match?.currentVisit,
    isThrower: Boolean(isThrower),
    // Every dart the evidence asks about is also a shot the director calls, at the same square. Two
    // pictures of one dart, one still and one move, so the two can be compared directly.
    direct: feed.direct,
  });
  evidenceHandler.current = evidence.handleControl;
  // Null draws no strip at all; an empty array draws it at full height, waiting. The difference is
  // a user not using the feature versus one whose first picture has not arrived.
  const evidenceImages = evidence.available ? evidence.images : null;

  // What a recorded clip of a board says about the match it was recording. Assembled here because
  // this is where the match lives; the panel draws it and knows nothing about what any of it means,
  // and every word of it is the mode's own rather than something this file worked out.
  const thrower = match?.players[match.currentPlayerIndex];
  const overlay = match && thrower
    ? overlayFor(thrower, match.currentVisit?.darts ?? [], view)
    : undefined;

  const navigate = useNavigate();

  // Navigate when lobby/match state arrives via WebSocket
  useEffect(() => {
    if (lobby && window.location.pathname === '/') {
      navigate(`/lobby/${lobby.id}`, { replace: true });
    }
  }, [lobby, navigate]);

  // Keyed on the match id, not merely on being somewhere under /match/: a re-match is a different
  // match, and leaving the old id in the URL would hand out a link to the wrong one. Spectators are
  // carried into a re-match too, and keep their own kind of link.
  useEffect(() => {
    if (!match || match.status !== 'in_progress') return;
    const path = isSpectator ? `/spectate/${match.id}` : `/match/${match.id}`;
    if (window.location.pathname !== path) navigate(path, { replace: true });
  }, [match, isSpectator, navigate]);

  // Navigate to home when lobby/match is abandoned (skip if page reload with reconnect info)
  useEffect(() => {
    if (!lobby && !match && window.location.pathname !== '/' && !window.location.pathname.startsWith('/lobby/join/')) {
      // Don't navigate away if we're about to reconnect after a page reload
      if (loadReconnectInfo()) return;
      navigate('/', { replace: true });
    }
  }, [lobby, match, navigate]);

  // When entering a lobby, start cameras on all claimed+online devices so they are already
  // streaming by the time the match begins. The scorer device's own auto-start on match begin is
  // kept as a fallback for cameras that powered down during a long lobby.
  const lobbyCameraStarted = useRef(false);
  useEffect(() => {
    if (lobby && !lobbyCameraStarted.current) {
      lobbyCameraStarted.current = true;
      for (const d of devices.devices) {
        if (d.active && d.online && !d.cameraActive) {
          devices.setCamera(d.deviceId, true);
        }
      }
    }
    if (!lobby) lobbyCameraStarted.current = false;
  }, [lobby, devices.devices, devices.setCamera]);

  return (
    // The shell is exactly the window, and `main` is what scrolls inside it. That is what lets a
    // screen ask to fill the height it has been given — the match screen does, so that a board and
    // a scoreboard behave like an app rather than a document — while pages that are simply long,
    // like the lobby, still scroll normally.
    <div className="h-[100dvh] flex flex-col">
      <TopBar
        connected={connected}
        devices={devices.devices}
        pairing={devices.pairing}
        pairingCode={devices.pairingCode}
        onStartPairing={devices.startPairing}
        onRequestPairingCode={devices.requestPairingCode}
        onCancelPairing={devices.cancelPairing}
        onGrab={devices.grab}
        onRelease={devices.release}
        onForget={devices.forget}
        onSetCamera={devices.setCamera}
        onPowerOff={devices.powerOff}
        media={media.config?.enabled ? wantsMedia : null}
        onMediaChange={(next) => setWantsMedia(saveMediaEnabled(next))}
        boardCamera={boardCamera}
        onBoardCameraChange={(next) => setBoardCamera(saveBoardCamera(next))}
      />
      <main className="flex-1 min-h-0 flex flex-col overflow-y-auto">
      <Routes>
        <Route path="/" element={
          <HomePage
            onCreateLocalMatch={() => { createLobby(true); }}
            onCreateOnlineMatch={() => { createLobby(false); }}
            connected={connected}
            notice={notice}
          />
        } />

        <Route path="/lobby/join/:code" element={
          <JoinHandler onJoin={joinLobby} lobby={lobby} error={error} />
        } />

        <Route path="/lobby/:id" element={
          <LobbyWrapper
            lobby={lobby}
            modes={modes}
            ownPlayerId={ownPlayerId}
            isSpectator={isSpectator}
            isHost={isHost}
            startMatch={startMatch}
            leaveMatch={leaveMatch}
            updateSettings={updateSettings}
            addLocalPlayer={addLocalPlayer}
            removePlayer={removePlayer}
            swapPlayers={swapPlayers}
            navigate={navigate}
            error={error}
          />
        } />

        <Route path="/match/:id" element={
          <MatchWrapper
            match={match}
            view={view}
            panel={panel}
            ownPlayerId={ownPlayerId}
            isSpectator={isSpectator}
            leaveMatch={leaveMatch}
            addDart={addDart}
            undoDart={undoDart}
            submitVisit={submitVisit}
            onVoteRematch={voteRematch}
            evidence={evidenceImages}
            navigate={navigate}
            error={error}
          />
        } />

        <Route path="/spectate/:id" element={
          <SpectateWrapper spectate={spectate} lobby={lobby} match={match} view={view} panel={panel} modes={modes} leaveMatch={leaveMatch} navigate={navigate} evidence={evidenceImages} />
        } />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </main>
      <MediaDebugPanel media={media} evidenceTimings={evidence.timings} feed={feed} overlay={overlay} />
    </div>
  );
}

interface LobbyWrapperProps {
  lobby: Lobby | null;
  modes: ModeDescriptor[];
  ownPlayerId: string | null;
  isSpectator: boolean;
  /** Whether this user created the lobby — the server's answer, sent to this connection alone. */
  isHost: boolean;
  startMatch: (lobbyId: string) => void;
  leaveMatch: (matchId: string) => void;
  updateSettings: (lobbyId: string, settings: any) => void;
  addLocalPlayer: (lobbyId: string, name: string) => void;
  removePlayer: (lobbyId: string, playerId: string) => void;
  swapPlayers: (lobbyId: string) => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  error: string | null;
}

function LobbyWrapper({ lobby, modes, ownPlayerId, isSpectator, isHost, startMatch, leaveMatch, updateSettings, addLocalPlayer, removePlayer, swapPlayers, navigate, error }: LobbyWrapperProps) {
  useNavigationGuard(lobby, error, navigate);

  if (!lobby) return <div className="flex-1 flex items-center justify-center text-gray-400">Loading lobby...</div>;
  return (
    <LobbyPage
      lobby={lobby}
      modes={modes}
      mode={lobby.isLocal ? 'local' : 'online'}
      isCreator={isHost || lobby.isLocal}
      ownPlayerId={ownPlayerId}
      isSpectator={isSpectator}
      onStartGame={() => startMatch(lobby.id)}
      onLeave={() => { leaveMatch(lobby.id); navigate('/'); }}
      onUpdateSettings={(s: any) => updateSettings(lobby.id, s)}
      onAddLocalPlayer={(n: string) => addLocalPlayer(lobby.id, n)}
      onRemovePlayer={(p: string) => removePlayer(lobby.id, p)}
      onSwapPlayers={() => swapPlayers(lobby.id)}
    />
  );
}

interface MatchWrapperProps {
  match: MatchState | null;
  view: ModeView | null;
  panel?: ModePanel;
  ownPlayerId: string | null;
  isSpectator: boolean;
  leaveMatch: (matchId: string) => void;
  addDart: (matchId: string, dart: any) => void;
  undoDart: (matchId: string) => void;
  submitVisit: (matchId: string) => void;
  onVoteRematch: (matchId: string, playerId: string, answer: RematchAnswer | 'neutral') => void;
  evidence: (string | undefined)[] | null;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  error: string | null;
}

function MatchWrapper({ match, view, panel, ownPlayerId, isSpectator, evidence, leaveMatch, addDart, undoDart, submitVisit, onVoteRematch, navigate, error }: MatchWrapperProps) {
  useNavigationGuard(match, error, navigate);

  if (!match || !view) return <div className="flex-1 flex items-center justify-center text-gray-400">Loading match...</div>;
  return (
    <MatchScreen
      match={match}
      view={view}
      panel={panel}
      ownPlayerId={ownPlayerId}
      isSpectator={isSpectator}
      onLeave={() => { leaveMatch(match.id); navigate('/'); }}
      onAddDart={(gid: string, dart: any) => addDart(gid, dart)}
      onUndoDart={() => undoDart(match.id)}
      onSubmitVisit={() => submitVisit(match.id)}
      onVoteRematch={(playerId: string, answer: RematchAnswer | 'neutral') => onVoteRematch(match.id, playerId, answer)}
      evidence={evidence}
    />
  );
}

interface SpectateWrapperProps {
  spectate: (id: string) => void;
  lobby: Lobby | null;
  match: MatchState | null;
  view: ModeView | null;
  panel?: ModePanel;
  modes: ModeDescriptor[];
  leaveMatch: (matchId: string) => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  evidence: (string | undefined)[] | null;
}

function SpectateWrapper({ spectate, lobby, match, view, panel, modes, leaveMatch, navigate, evidence }: SpectateWrapperProps) {
  const { id } = useParams<{ id: string }>();

  useEffect(() => {
    if (id) spectate(id);
  }, [id]);

  const handleLeave = () => {
    leaveMatch(lobby?.id ?? match?.id ?? '');
    navigate('/');
  };

  if (lobby) {
    return (
      <LobbyPage
        lobby={lobby}
        modes={modes}
        mode={lobby.isLocal ? 'local' : 'online'}
        isCreator={false}
        ownPlayerId={null}
        isSpectator={true}
        onStartGame={() => {}}
        onLeave={handleLeave}
        onUpdateSettings={() => {}}
        onAddLocalPlayer={() => {}}
        onRemovePlayer={() => {}}
        onSwapPlayers={() => {}}
      />
    );
  }

  if (match && view) {
    return (
      <MatchScreen
        match={match}
        view={view}
        panel={panel}
        ownPlayerId={null}
        isSpectator={true}
        onLeave={() => navigate('/')}
        onAddDart={() => {}}
        onUndoDart={() => {}}
        onSubmitVisit={() => {}}
        onVoteRematch={() => {}}
        evidence={evidence}
      />
    );
  }

  return <div className="flex-1 flex items-center justify-center text-gray-400">Loading...</div>;
}
