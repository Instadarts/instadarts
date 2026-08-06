import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScorerStateMessage, ServerMessage } from '../../shared/protocol';
import type { BoardTip } from '../../shared/vision/types';
import { useWebSocket } from './useWebSocket';
import { forgetIdentity, loadIdentity, saveIdentity, type ScorerIdentity } from '../lib/scorerStorage';

export type ScorerLinkStatus = 'connecting' | 'unpaired' | 'pairing' | 'waiting' | 'active';

/**
 * The scoring device's side of the link: prove who we are, publish what the camera saw, and hold
 * the retained state the server pushes back.
 *
 * `scorer_hello` goes out on every (re)connect, which is what makes a pairing survive a server
 * restart — the server keeps nothing, and our token is the proof it needs.
 */
export function useScorerLink() {
  const [identity, setIdentity] = useState<ScorerIdentity | null>(() => loadIdentity());
  const [state, setState] = useState<ScorerStateMessage | null>(null);
  const [refusal, setRefusal] = useState<'unpaired' | 'bad_code' | null>(null);
  const [pairing, setPairing] = useState(false);

  const identityRef = useRef(identity);
  identityRef.current = identity;

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'scorer_paired': {
        const next = { deviceId: msg.deviceId, token: msg.token, name: identityRef.current?.name ?? '' };
        saveIdentity(next);
        setIdentity(next);
        setRefusal(null);
        setPairing(false);
        break;
      }
      case 'scorer_state':
        setState(msg);
        setRefusal(null);
        break;
      case 'scorer_refused':
        setRefusal(msg.reason);
        setPairing(false);
        if (msg.reason === 'unpaired') {
          // The server does not know this identity. Nothing it holds can bring it back.
          forgetIdentity();
          setIdentity(null);
          setState(null);
        }
        break;
    }
  }, []);

  const { send, connected } = useWebSocket(handleMessage, { resumeSession: false });

  // Identify on every connection, not once on mount: a reconnect after a server restart is exactly
  // when this matters most.
  useEffect(() => {
    if (!connected) {
      setState(null);
      return;
    }
    const current = identityRef.current;
    if (current) {
      send({ type: 'scorer_hello', deviceId: current.deviceId, token: current.token, name: current.name });
    }
  }, [connected, send]);

  const pair = useCallback((code: string) => {
    setPairing(true);
    setRefusal(null);
    send({ type: 'scorer_pair', code });
  }, [send]);

  const setCameraActive = useCallback((active: boolean) => {
    send({ type: 'scorer_camera', active });
  }, [send]);

  /**
   * One inference's board-space tips. An empty array is the takeout signal and must only ever be
   * sent for a frame that solved a homography — see visionRuntime's guard.
   */
  const sendTips = useCallback((tips: BoardTip[], ms?: number) => {
    send({ type: 'scorer_tips', tips, ms });
  }, [send]);

  const rename = useCallback((name: string) => {
    const current = identityRef.current;
    if (!current) return;
    const next = { ...current, name };
    saveIdentity(next);
    setIdentity(next);
  }, []);

  /**
   * Tell the frontend what this device is called. Separate from `rename` so it fires when the user
   * has finished typing rather than once per keystroke — a name is not worth a message a character.
   */
  const publishName = useCallback(() => {
    const current = identityRef.current;
    if (current) send({ type: 'scorer_name', name: current.name });
  }, [send]);

  const status: ScorerLinkStatus = !connected
    ? 'connecting'
    : pairing
      ? 'pairing'
      : !identity
        ? 'unpaired'
        : (state?.status ?? 'waiting');

  return { identity, status, state, refusal, connected, pair, rename, publishName, setCameraActive, sendTips };
}
