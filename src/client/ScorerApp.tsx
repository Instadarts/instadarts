import { useState } from 'react';
import { useScorerLink } from './hooks/useScorerLink';
import { JoinView } from './pages/scorer/JoinView';
import { ScorerPage } from './pages/scorer/ScorerPage';

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
  const link = useScorerLink({ standby });

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
      />
    </div>
  );
}
