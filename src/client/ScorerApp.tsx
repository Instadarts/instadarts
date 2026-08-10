import { useRef, useState } from 'react';
import type { ServerMessage } from '../shared/protocol';
import type { Mesh } from './media/mesh';
import type { ControlMessage, Region } from '../shared/media';
import { useStillResponder, type StillSource } from './hooks/useStillResponder';
import { useVideoResponder } from './hooks/useVideoResponder';
import type { VideoFrameSource } from './media/videoPublisher';
import { useScorerLink } from './hooks/useScorerLink';
import { useMediaMesh } from './hooks/useMediaMesh';
import { JoinView } from './pages/scorer/JoinView';
import { ScorerPage } from './pages/scorer/ScorerPage';
import { MediaDebugPanel } from './components/MediaDebugPanel';
import { loadSettings } from './lib/scorerStorage';

/**
 * The scoring device app. A sibling of App, not a route inside it: it has its own socket, its own
 * storage keys and no business with lobbies, matches or navigation.
 *
 * Standby is held here rather than in either hook below, because it is the one thing they both
 * need: the page decides when this device has waited long enough, and the link is what closes the
 * socket when it has. Passing it down and taking it back up is what keeps that a single value.
 */
export function ScorerApp() {
  const [standby, setStandby] = useState(false);
  // Read once: the mesh only asks whether this phone takes part, and a phone that changes its mind
  // mid-evening is a reload away from being heard. The settings panel writes it either way.
  const [wantsMedia, setWantsMedia] = useState(() => loadSettings().media);
  // Media shares the link's socket, but the socket is created inside it. The ref is what lets the
  // two be introduced without either owning the other — the same arrangement App.tsx uses.
  const mediaHandler = useRef<((msg: ServerMessage) => void) | null>(null);
  const videoControl = useRef<((from: string, message: ControlMessage) => void) | null>(null);

  // The camera lives inside ScorerPage and the mesh lives here, so the two are introduced through
  // refs rather than one owning the other — the same arrangement as the message handler above.
  const meshRef = useRef<Mesh | null>(null);
  const stillSource = useRef<StillSource | null>(null);
  const stills = useStillResponder(meshRef, stillSource);

  // The live feed's two halves of the same introduction. `directVideo` is separate from the frame
  // source because a director's region outlives a camera session and the frames do not.
  const videoSource = useRef<VideoFrameSource | null>(null);
  const directVideo = useRef<((region: Region | null, transitionMs: number, resetMs: number) => void) | null>(null);
  // Held here rather than read off the link, because the responder has to stop a feed the moment the
  // camera goes — including when power management is what turned it off.
  const [cameraActive, setCameraActive] = useState(false);

  const link = useScorerLink({ standby, onServerMessage: (msg) => mediaHandler.current?.(msg) });
  // A sleeping phone holds no peer connections: the socket is deliberately shut in standby, and the
  // links would have nothing to renegotiate with and nobody to tell.
  const mesh = useMediaMesh(link.send, link.connected && !standby, {
    tier: wantsMedia,
    // Both responders see every message and each ignores what is not its own, so neither has to know
    // the other exists. Through a ref for the same reason the server messages are: the responder is
    // built below, and introducing the two by hand beats making one own the other.
    onControl: (from, message) => {
      stills.handleControl(from, message);
      videoControl.current?.(from, message);
    },
  });

  const video = useVideoResponder({
    meshRef,
    sourceRef: videoSource,
    directRef: directVideo,
    tier: wantsMedia,
    profile: mesh.config?.video ?? null,
    cameraActive,
  });
  videoControl.current = video.handleControl;
  mediaHandler.current = mesh.handleMessage;
  meshRef.current = mesh.mesh;

  if (!link.identity) {
    return (
      <div className="min-h-screen flex flex-col">
        <JoinView
          onPair={link.pair}
          pairing={link.status === 'pairing'}
          badCode={link.refusal === 'bad_code'}
          serverFull={link.refusal === 'server_full'}
          connected={link.connected}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <ScorerPage
        status={link.status}
        scoring={link.scoring}
        command={link.command}
        onStandbyChange={setStandby}
        name={link.name}
        onRename={link.rename}
        onNameSettled={link.publishName}
        onUnpair={link.unpair}
        onTips={link.sendTips}
        onCameraActive={(active, error) => { setCameraActive(active); link.setCameraActive(active, error); }}
        onMediaChange={setWantsMedia}
        stillSource={stillSource}
        videoSource={videoSource}
        directVideo={directVideo}
      />
      <MediaDebugPanel media={mesh} stillTimings={stills.timings} publisherStats={video.stats} />
    </div>
  );
}
