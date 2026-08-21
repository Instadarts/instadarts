import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMatch } from './hooks/useMatch';
import { useScoringDevices } from './hooks/useScoringDevices';
import { useMediaMesh } from './hooks/useMediaMesh';
import { useMatchMediaSetup } from './hooks/useMatchMediaSetup';
import { useDartEvidence } from './hooks/useDartEvidence';
import { labelVideoFeedsForMatch, selectVideoFeed, useVideoFeed } from './hooks/useVideoFeed';
import { MediaDebugPanel } from './components/MediaDebugPanel';
import { VideoOfferDialog } from './components/VideoOfferDialog';
import { loadBoardCamera, loadMediaEnabled, saveBoardCamera, saveMediaEnabled } from './lib/mediaStorage';
import { useNavigationGuard } from './hooks/useNavigationGuard';
import { HomePage } from './pages/HomePage';
import { LobbyPage } from './pages/LobbyPage';
import { MatchScreen } from './pages/MatchScreen';
import { JoinHandler } from './pages/JoinHandler';
import { TopBar } from './components/TopBar';
import { SourceFooter } from './components/SourceFooter';
import { loadReconnectInfo } from './lib/ws';
import type { ServerMessage } from '../shared/protocol';
import type { ControlMessage, VideoFeedId } from '../shared/media';
import type { VideoFeedView } from './hooks/useVideoFeed';
import type { Lobby, MatchState, ModePanel, ModeView, RematchAnswer } from '../shared/types';
import { boardCount } from '../shared/types';
import type { ModeDescriptor } from '../shared/settings';
import { modeBans } from '../shared/settings';
import { CONFIG_DEFAULTS } from '../shared/config';

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
    connectionGeneration,
    roomGeneration,
    mediaDisabled,
    ownPlayerIds,
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
    reorderPlayer,
    voteRematch,
    addDart,
    undoDart,
  } = useMatch((msg) => { devicesHandler.current?.(msg); mediaHandler.current?.(msg); });

  const devices = useScoringDevices(send, connected);
  devicesHandler.current = devices.handleMessage;

  const [wantsMedia, setWantsMedia] = useState(() => loadMediaEnabled());
  // Which of this tab's claimed devices is shared as this player's board.
  const [boardCamera, setBoardCamera] = useState(() => loadBoardCamera());
  // Nominating a board is asking to be watched, and the media switch is what decides whether this
  // browser takes part at all. Doing the first with the second off would be a control that did
  // nothing, so it turns the switch on rather than quietly disagreeing with it.
  //
  // The reverse is not symmetrical: switching media off leaves the nomination in place, so that
  // switching it back on restores the board somebody already chose. Nothing leaks in the meantime —
  // useMediaMesh sends boardCamera: null for tier `disabled`, and the top bar reads its switches
  // off to match.
  const changeBoardCamera = useCallback((deviceId: string | null) => {
    setBoardCamera(saveBoardCamera(deviceId));
    if (deviceId !== null && !wantsMedia) setWantsMedia(saveMediaEnabled(true));
  }, [wantsMedia]);
  // Whose visit is on screen — the thrower's, whoever that is. Only they may ask a camera for dart
  // evidence or direct their own feed.
  const currentPlayer = match?.players[match.currentPlayerIndex];
  const isThrower = !isSpectator && match?.status === 'in_progress'
    && ownPlayerIds.includes(currentPlayer?.id ?? '');

  const evidenceHandler = useRef<((from: string, message: ControlMessage, payload?: Uint8Array) => void) | null>(null);
  const feedHandler = useRef<((from: string, message: ControlMessage) => void) | null>(null);
  const feedMedia = useRef<((from: string, data: ArrayBuffer) => void) | null>(null);
  const media = useMediaMesh(send, connected, {
    tier: wantsMedia ? 'video' : 'disabled',
    // A match with more than two boards is never given a session, so joining one would only build
    // peer machinery for a roster that is never coming. Respected here as well as enforced there.
    matchId: match?.status === 'in_progress' && !mediaDisabled ? match.id : null,
    declarationVersion: roomGeneration,
    declarationReady: devices.claimsReady,
    boardCamera,
    onControl: (from, message, payload) => {
      evidenceHandler.current?.(from, message, payload);
      feedHandler.current?.(from, message);
    },
    onMedia: (from, data) => feedMedia.current?.(from, data),
  });
  mediaHandler.current = media.handleMessage;

  // What this match's game mode declined, if anything. The catalog arrives on connect, before any
  // lobby exists, so it is always here by match time — and if it somehow were not, `modeBans` reads
  // as banning nothing, which is the behaviour of every mode that says nothing.
  const modeDescriptor = modes.find((candidate) => candidate.id === match?.settings.mode);

  const liveVideoActive = Boolean(match?.status === 'in_progress');
  // One board means the only board is your own, so there is nothing for a player to receive — its
  // single feed is offered to spectators alone. The server says the same thing in `audienceFor`.
  const oneBoard = match ? boardCount(match.players) === 1 : false;
  const feed = useVideoFeed({
    mesh: media.mesh,
    config: media.config,
    links: media.links,
    // The server withholds the source directive for a mode that declined video, so there is
    // normally nothing to refuse. Said here as well because this is the side that would have to
    // draw it, and a screen that quietly refuses what it cannot use is worth more than the saving.
    receive: liveVideoActive && (!oneBoard || isSpectator) && !modeBans(modeDescriptor, 'boardVideo'),
    anticipate: false,
  });
  feedHandler.current = feed.handleControl;
  feedMedia.current = feed.handleMedia;
  const videoFeeds = labelVideoFeedsForMatch(feed.feeds, match);
  const displayFeed = { ...feed, feeds: videoFeeds };

  const evidence = useDartEvidence({
    mesh: media.mesh,
    links: media.links,
    currentVisit: match?.currentVisit,
    isThrower: Boolean(isThrower),
    // Every dart the evidence asks about is also a shot the director calls, at the same square. Two
    // pictures of one dart, one still and one move, so the two can be compared directly.
    direct: feed.direct,
    // A still request never reaches the server — it is one peer asking another — so a mode that
    // declined evidence is honoured by not asking.
    enabled: !modeBans(modeDescriptor, 'dartEvidence'),
  });
  evidenceHandler.current = evidence.handleControl;
  // Null draws no strip at all; an empty array draws it at full height, waiting. The difference is
  // a user not using the feature versus one whose first picture has not arrived.
  const evidenceImages = evidence.available ? evidence.images : null;

  const ownBoardId = match?.players.find((p) => ownPlayerIds.includes(p.id))?.boardId ?? null;
  const currentBoardId = currentPlayer?.boardId ?? null;
  const liveFeed = selectVideoFeed(videoFeeds, currentBoardId, ownBoardId, isSpectator);
  const pendingVideoOffer = liveVideoActive
    ? videoFeeds.find((candidate) => candidate.choice === 'pending') ?? null
    : null;
  const mediaSettingUp = useMatchMediaSetup(
    liveVideoActive ? match!.id : null,
    wantsMedia ? (media.config?.enabled ?? null) : false,
    media.config?.setupTimeoutMs ?? CONFIG_DEFAULTS.media.setupTimeoutMs,
    media.session,
    media.links,
  );
  const mediaSetupWasVisible = useRef(false);
  useEffect(() => {
    if (!match?.id) return;
    if (mediaSettingUp && !mediaSetupWasVisible.current) {
      mediaSetupWasVisible.current = true;
      performance.mark(`media-setup:${match.id}`);
      performance.mark(`media-setup-start:${match.id}`);
    } else if (!mediaSettingUp && mediaSetupWasVisible.current) {
      mediaSetupWasVisible.current = false;
      performance.mark(`media-setup-end:${match.id}`);
    }
  }, [mediaSettingUp, match?.id]);

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
    if (!lobby && !match
      && window.location.pathname !== '/'
      && !window.location.pathname.startsWith('/lobby/join/')
      && !window.location.pathname.startsWith('/spectate/')) {
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
        onBoardCameraChange={changeBoardCamera}
      />
      <main className="flex-1 min-h-0 flex flex-col overflow-y-auto">
      <Routes>
        <Route path="/" element={
          <HomePage
            onCreateLocalMatch={() => { createLobby(false); }}
            onCreateOnlineMatch={() => { createLobby(true); }}
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
            ownPlayerIds={ownPlayerIds}
            isSpectator={isSpectator}
            isHost={isHost}
            startMatch={startMatch}
            leaveMatch={leaveMatch}
            updateSettings={updateSettings}
            addLocalPlayer={addLocalPlayer}
            removePlayer={removePlayer}
            reorderPlayer={reorderPlayer}
            navigate={navigate}
            error={error}
          />
        } />

        <Route path="/match/:id" element={
          <MatchWrapper
            match={match}
            view={view}
            panel={panel}
            mediaDisabled={mediaDisabled}
            ownPlayerIds={ownPlayerIds}
            isSpectator={isSpectator}
            leaveMatch={leaveMatch}
            addDart={addDart}
            undoDart={undoDart}
            submitVisit={submitVisit}
            onVoteRematch={voteRematch}
            evidence={evidenceImages}
            liveFeed={liveFeed}
            videoOffers={videoFeeds}
            onAcceptVideo={feed.accept}
            onDeclineVideo={feed.decline}
            navigate={navigate}
            error={error}
          />
        } />

        <Route path="/spectate/:id" element={
          <SpectateWrapper spectate={spectate} connected={connected} connectionGeneration={connectionGeneration} lobby={lobby} match={match} view={view} panel={panel} mediaDisabled={mediaDisabled} modes={modes} leaveMatch={leaveMatch} navigate={navigate} evidence={evidenceImages} liveFeed={liveFeed} videoOffers={videoFeeds} onAcceptVideo={feed.accept} onDeclineVideo={feed.decline} />
        } />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </main>
      <SourceFooter />
      <MediaDebugPanel media={media} evidenceTimings={evidence.timings} feed={displayFeed} />
      {mediaSettingUp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950 text-white" data-testid="media-setup-overlay">
          <div className="text-center">
            <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-gray-600 border-t-white" />
            <p className="text-lg font-medium">Setting up match…</p>
          </div>
        </div>
      )}
      {!mediaSettingUp && pendingVideoOffer && (
        <VideoOfferDialog
          feedId={pendingVideoOffer.feedId}
          label={pendingVideoOffer.label}
          onAccept={feed.accept}
          onDecline={feed.decline}
        />
      )}
    </div>
  );
}

interface LobbyWrapperProps {
  lobby: Lobby | null;
  modes: ModeDescriptor[];
  ownPlayerIds: string[];
  isSpectator: boolean;
  /** Whether this user created the lobby — the server's answer, sent to this connection alone. */
  isHost: boolean;
  startMatch: (lobbyId: string) => void;
  leaveMatch: (matchId: string) => void;
  updateSettings: (lobbyId: string, settings: any) => void;
  addLocalPlayer: (lobbyId: string, name: string) => void;
  removePlayer: (lobbyId: string, playerId: string) => void;
  reorderPlayer: (lobbyId: string, playerId: string, direction: 'up' | 'down') => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  error: string | null;
}

function LobbyWrapper({ lobby, modes, ownPlayerIds, isSpectator, isHost, startMatch, leaveMatch, updateSettings, addLocalPlayer, removePlayer, reorderPlayer, navigate, error }: LobbyWrapperProps) {
  useNavigationGuard(lobby, error, navigate);

  if (!lobby) return <div className="flex-1 flex items-center justify-center text-gray-400">Loading lobby...</div>;
  return (
    <LobbyPage
      lobby={lobby}
      modes={modes}
      mode={lobby.acceptsJoins ? 'online' : 'local'}
      isCreator={isHost}
      ownPlayerIds={ownPlayerIds}
      isSpectator={isSpectator}
      onStartGame={() => startMatch(lobby.id)}
      onLeave={() => { leaveMatch(lobby.id); navigate('/'); }}
      onUpdateSettings={(s: any) => updateSettings(lobby.id, s)}
      onAddLocalPlayer={(n: string) => addLocalPlayer(lobby.id, n)}
      onRemovePlayer={(p: string) => removePlayer(lobby.id, p)}
      onReorderPlayer={(playerId, direction) => reorderPlayer(lobby.id, playerId, direction)}
    />
  );
}

interface MatchWrapperProps {
  match: MatchState | null;
  view: ModeView | null;
  panel?: ModePanel;
  mediaDisabled: boolean;
  ownPlayerIds: string[];
  isSpectator: boolean;
  leaveMatch: (matchId: string) => void;
  addDart: (matchId: string, dart: any) => void;
  undoDart: (matchId: string) => void;
  submitVisit: (matchId: string) => void;
  onVoteRematch: (matchId: string, playerId: string, answer: RematchAnswer | 'neutral') => void;
  evidence: (string | undefined)[] | null;
  liveFeed: ReturnType<typeof selectVideoFeed>;
  videoOffers: readonly VideoFeedView[];
  onAcceptVideo: (feedId: VideoFeedId) => void;
  onDeclineVideo: (feedId: VideoFeedId) => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  error: string | null;
}

function MatchWrapper({ match, view, panel, mediaDisabled, ownPlayerIds, isSpectator, evidence, liveFeed, videoOffers, onAcceptVideo, onDeclineVideo, leaveMatch, addDart, undoDart, submitVisit, onVoteRematch, navigate, error }: MatchWrapperProps) {
  useNavigationGuard(match, error, navigate);

  if (!match || !view) return <div className="flex-1 flex items-center justify-center text-gray-400">Loading match...</div>;
  return (
    <MatchScreen
      match={match}
      view={view}
      panel={panel}
      mediaDisabled={mediaDisabled}
      ownPlayerIds={ownPlayerIds}
      isSpectator={isSpectator}
      onLeave={() => { leaveMatch(match.id); navigate('/'); }}
      onAddDart={(gid: string, dart: any) => addDart(gid, dart)}
      onUndoDart={() => undoDart(match.id)}
      onSubmitVisit={() => submitVisit(match.id)}
      onVoteRematch={(playerId: string, answer: RematchAnswer | 'neutral') => onVoteRematch(match.id, playerId, answer)}
      evidence={evidence}
      liveFeed={liveFeed}
      videoOffers={videoOffers}
      onAcceptVideo={onAcceptVideo}
      onDeclineVideo={onDeclineVideo}
    />
  );
}

interface SpectateWrapperProps {
  spectate: (id: string) => void;
  connected: boolean;
  connectionGeneration: number;
  lobby: Lobby | null;
  match: MatchState | null;
  view: ModeView | null;
  panel?: ModePanel;
  mediaDisabled: boolean;
  modes: ModeDescriptor[];
  leaveMatch: (matchId: string) => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  evidence: (string | undefined)[] | null;
  liveFeed: ReturnType<typeof selectVideoFeed>;
  videoOffers: readonly VideoFeedView[];
  onAcceptVideo: (feedId: VideoFeedId) => void;
  onDeclineVideo: (feedId: VideoFeedId) => void;
}

function SpectateWrapper({ spectate, connected, connectionGeneration, lobby, match, view, panel, mediaDisabled, modes, leaveMatch, navigate, evidence, liveFeed, videoOffers, onAcceptVideo, onDeclineVideo }: SpectateWrapperProps) {
  const { id } = useParams<{ id: string }>();
  const lastSpectateRef = useRef<string | null>(null);

  useEffect(() => {
    if (!id || !connected) return;
    const requestKey = `${connectionGeneration}:${id}`;
    if (lastSpectateRef.current === requestKey) return;
    lastSpectateRef.current = requestKey;
    spectate(id);
  }, [id, connected, connectionGeneration, spectate]);

  const handleLeave = () => {
    leaveMatch(lobby?.id ?? match?.id ?? '');
    navigate('/');
  };

  if (lobby) {
    return (
      <LobbyPage
        lobby={lobby}
        modes={modes}
        mode={lobby.acceptsJoins ? 'online' : 'local'}
        isCreator={false}
        ownPlayerIds={[]}
        isSpectator={true}
        onStartGame={() => {}}
        onLeave={handleLeave}
        onUpdateSettings={() => {}}
        onAddLocalPlayer={() => {}}
        onRemovePlayer={() => {}}
        onReorderPlayer={() => {}}
      />
    );
  }

  if (match && view) {
    return (
      <MatchScreen
        match={match}
        view={view}
        panel={panel}
        mediaDisabled={mediaDisabled}
        ownPlayerIds={[]}
        isSpectator={true}
        onLeave={() => navigate('/')}
        onAddDart={() => {}}
        onUndoDart={() => {}}
        onSubmitVisit={() => {}}
        onVoteRematch={() => {}}
        evidence={evidence}
        liveFeed={liveFeed}
        videoOffers={videoOffers}
        onAcceptVideo={onAcceptVideo}
        onDeclineVideo={onDeclineVideo}
      />
    );
  }

  return <div className="flex-1 flex items-center justify-center text-gray-400">Loading...</div>;
}
