import { useScorerLink } from './hooks/useScorerLink';
import { JoinView } from './pages/scorer/JoinView';
import { ScorerPage } from './pages/scorer/ScorerPage';

/**
 * The scoring device app. A sibling of App, not a route inside it: it has its own socket, its own
 * storage keys and no business with lobbies, matches or navigation.
 */
export function ScorerApp() {
  const link = useScorerLink();

  if (!link.identity) {
    return (
      <div className="min-h-screen flex flex-col">
        <JoinView
          onPair={link.pair}
          pairing={link.status === 'pairing'}
          badCode={link.refusal === 'bad_code'}
          connected={link.connected}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <ScorerPage
        status={link.status}
        name={link.identity.name}
        onRename={link.rename}
        onNameSettled={link.publishName}
        onTips={link.sendTips}
        onCameraActive={link.setCameraActive}
      />
    </div>
  );
}
