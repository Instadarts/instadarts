import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScorerStateMessage, ServerMessage } from '../../shared/protocol';
import type { BoardTip } from '../../shared/vision/types';
import { useWebSocket } from './useWebSocket';
import {
  forgetIdentity,
  loadDeviceName,
  loadIdentity,
  saveDeviceName,
  saveIdentity,
  type ScorerIdentity,
} from '../lib/scorerStorage';

export type ScorerLinkStatus = 'connecting' | 'unpaired' | 'pairing' | 'waiting' | 'active' | 'full';

/**
 * A command from the owner, with the count of how many have arrived.
 *
 * The count is the message: a command is an event, and React state is not, so the sequence is what
 * lets whoever acts on one tell a repeat from a re-render.
 */
export interface PendingCommand {
  name: 'camera_on' | 'camera_off' | 'power_off';
  seq: number;
}

/**
 * The scoring device's side of the link: prove who we are, publish what the camera saw, and hold
 * the retained state the server pushes back.
 *
 * `scorer_hello` goes out on every (re)connect, which is what makes a pairing survive a server
 * restart — the server keeps nothing, and our token is the proof it needs.
 */
interface ScorerLinkOptions {
  standby?: boolean;
  /**
   * Also called for every frame, before this hook handles it. Lets a second concern — media — share
   * the one socket without this hook knowing anything about it, exactly as `useMatch` does for the
   * gaming frontend.
   */
  onServerMessage?: (msg: ServerMessage) => void;
}

export function useScorerLink({ standby = false, onServerMessage }: ScorerLinkOptions = {}) {
  const [identity, setIdentity] = useState<ScorerIdentity | null>(() => loadIdentity());
  const [name, setName] = useState(() => loadDeviceName());
  const [state, setState] = useState<ScorerStateMessage | null>(null);
  const [refusal, setRefusal] = useState<'unpaired' | 'bad_code' | 'server_full' | null>(null);
  const [pairing, setPairing] = useState(false);
  const [command, setCommand] = useState<PendingCommand | null>(null);

  const identityRef = useRef(identity);
  identityRef.current = identity;
  const nameRef = useRef(name);
  nameRef.current = name;
  /** Set once `send` exists, so the pairing handler below can answer with this device's name. */
  const sendRef = useRef<(msg: object) => void>(() => {});

  const extraHandlerRef = useRef(onServerMessage);
  extraHandlerRef.current = onServerMessage;

  const handleMessage = useCallback((msg: ServerMessage) => {
    extraHandlerRef.current?.(msg);

    switch (msg.type) {
      case 'scorer_paired': {
        const next = { deviceId: msg.deviceId, token: msg.token };
        saveIdentity(next);
        setIdentity(next);
        setRefusal(null);
        setPairing(false);
        // A device that already had a name keeps it through a re-pairing, so say so straight away
        // rather than letting the new owner sit on the placeholder it just invented.
        if (nameRef.current) sendRef.current({ type: 'scorer_name', name: nameRef.current });
        break;
      }
      case 'scorer_state':
        setState(msg);
        setRefusal(null);
        break;
      case 'scorer_command':
        // Numbered, because the same command twice in a row is two instructions: the owner turning
        // a camera off, back on, and off again must not collapse into one.
        setCommand((current) => ({ name: msg.command, seq: (current?.seq ?? 0) + 1 }));
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
        // `server_full` deliberately keeps the identity: the server having no room says nothing
        // about whether the pairing is good, and throwing it away would turn a busy minute into a
        // trip to the other screen for a new code.
        break;
    }
  }, []);

  const { send, connected } = useWebSocket(handleMessage, { resumeSession: false, standby });
  sendRef.current = send;

  // Identify on every connection, not once on mount: a reconnect after a server restart is exactly
  // when this matters most.
  //
  // The last known scorer_state is deliberately kept across disconnects rather than cleared.
  // Clearing it would make `scoring` go false→true on reconnect, which `useScorerPower` reads as a
  // match beginning and auto-starts the camera — undoing whatever the owner had just asked for.
  // A reconnect is not a match start, and a device that was scoring before the blip still is.
  useEffect(() => {
    if (!connected) return;
    const current = identityRef.current;
    if (current) {
      send({ type: 'scorer_hello', deviceId: current.deviceId, token: current.token, name: nameRef.current });
    }
  }, [connected, send]);

  const pair = useCallback((code: string) => {
    setPairing(true);
    setRefusal(null);
    send({ type: 'scorer_pair', code });
  }, [send]);

  /**
   * Deliberately forget the pairing, so this phone can be paired to another browser.
   *
   * The settings stay: they describe this camera, this lens and this phone's own name, none of
   * which changed. Only the identity goes — and the server is told, because a connection may only
   * pair while it is nobody's device, so an unpaired phone on a still-bound socket could not redeem
   * a new code.
   */
  const unpair = useCallback(() => {
    send({ type: 'scorer_unpair' });
    forgetIdentity();
    setIdentity(null);
    setState(null);
    setRefusal(null);
    setPairing(false);
  }, [send]);

  /**
   * What this device's camera is doing, and why it is not doing it.
   *
   * The owner's screen renders this and never its own request, because a camera can refuse to open
   * for reasons only this phone knows — a backgrounded tab, a permission that was never granted.
   */
  const setCameraActive = useCallback((active: boolean, error?: string) => {
    send({ type: 'scorer_camera', active, ...(error ? { error } : {}) });
  }, [send]);

  const scoring = state?.scoring === true;
  const scoringRef = useRef(scoring);
  scoringRef.current = scoring;

  /**
   * One inference's board-space tips. An empty array is the takeout signal and must only ever be
   * sent for a frame that solved a homography — see visionRuntime's guard.
   *
   * Dropped entirely outside a match. The server discards them there anyway (`resolveScoringTarget`
   * refuses before they reach a scoring session), so every one sent was a frame's worth of bandwidth
   * spent on nothing — and a camera run for aiming or calibration produces them continuously.
   */
  const sendTips = useCallback((tips: BoardTip[], ms?: number) => {
    if (!scoringRef.current) return;
    send({ type: 'scorer_tips', tips, ms });
  }, [send]);

  /** Renaming needs no pairing: a phone is allowed to be called something before it belongs to anyone. */
  const rename = useCallback((next: string) => {
    saveDeviceName(next);
    setName(next);
  }, []);

  /**
   * Tell the frontend what this device is called. Separate from `rename` so it fires when the user
   * has finished typing rather than once per keystroke — a name is not worth a message a character.
   */
  const publishName = useCallback(() => {
    if (identityRef.current) send({ type: 'scorer_name', name: nameRef.current });
  }, [send]);

  const status: ScorerLinkStatus = !connected
    ? 'connecting'
    : refusal === 'server_full'
      ? 'full'
      : pairing
        ? 'pairing'
        : !identity
          ? 'unpaired'
          : (state?.status ?? 'waiting');

  return {
    identity,
    name,
    status,
    state,
    scoring,
    command,
    refusal,
    connected,
    /** The raw socket, for a concern that shares it — see `onServerMessage`. */
    send,
    pair,
    unpair,
    rename,
    publishName,
    setCameraActive,
    sendTips,
  };
}
