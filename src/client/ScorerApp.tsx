import { useRef, useState } from 'react';
import type { ServerMessage } from '../shared/protocol';
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

  const link = useScorerLink({ standby, onServerMessage: (msg) => mediaHandler.current?.(msg) });
  // A sleeping phone holds no peer connections: the socket is deliberately shut in standby, and the
  // links would have nothing to renegotiate with and nobody to tell.
  const mesh = useMediaMesh(link.send, link.connected && !standby, { tier: wantsMedia });
  mediaHandler.current = mesh.handleMessage;

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
        onCameraActive={link.setCameraActive}
        onMediaChange={setWantsMedia}
      />
      <MediaDebugPanel media={mesh} />
    </div>
  );
}
