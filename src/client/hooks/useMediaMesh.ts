// The media feature's one hook, mounted by the gaming frontend and the scoring device alike.
//
// Both apps own a socket already, and neither owns it in a way the other can use — so this takes a
// `send` and is fed the frames the app receives, exactly as useScoringDevices does. What it holds is
// a mesh, which holds the links.
//
// Three conditions have to hold before this connection announces itself, and they are independent:
// the deployment allows media (`app_config`), this browser or phone wants it (the `enabled`
// argument), and there is a socket to announce over. Announcing is what puts a connection in other
// peers' rosters; there is no other way in, and no other way out.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaSourceStateMessage, ServerMessage } from '../../shared/protocol';
import type { ControlMessage, MediaPeer, MediaTier } from '../../shared/media';
import type { MediaClientConfig } from '../../shared/config';
import { createMesh, type Mesh, type MeshLink } from '../media/mesh';
import { setAppConfig, useMediaConfig } from '../lib/appConfig';
import { e2eEnabled } from '../lib/e2e';

export interface MediaMesh {
  /** Feed every server frame here, before or after the app's own handling. */
  handleMessage: (msg: ServerMessage) => void;
  /** What the deployment allows. Null until it has said. */
  config: MediaClientConfig | null;
  /** Whether this connection is taking part: the deployment, the preference and the socket all agreeing. */
  active: boolean;
  /** This connection's own peer id, once the server has minted one. */
  selfId: string | null;
  /** Current server-owned match/mesh incarnation and setup declaration state. */
  session: { matchId: string; meshId: string; setupComplete: boolean } | null;
  links: MeshLink[];
  /** The mesh itself, for the parts of the app that talk over a link. */
  mesh: Mesh | null;
  /** Ask for fresh link states — the mesh reports changes, but stats have to be pulled. */
  refresh: () => void;
  /** What has arrived. Only ever filled in a build that allows the e2e seam. */
  inbox: Inbox;
}

interface Options {
  /**
   * The most this connection is willing to send. `disabled` keeps it out of every roster — for a
   * frontend that is the "no video" switch, for a phone it is its own settings answer.
   */
  tier: MediaTier;
  /** Present only in the gaming frontend. Null means lobby/summary: no mesh exists. */
  matchId?: string | null;
  /** Ordering token used by spectators after issuing `spectate` on a replacement socket. */
  declarationVersion?: number;
  /**
   * The device this frontend is showing as its board, or null for none. Ignored by a scoring
   * device, which has no cameras of its own to nominate.
   *
   * Re-sent on every connect, like `activate_devices`, since the server keeps nothing across one.
   */
  boardCamera?: string | null;
  /** A control-channel message from a peer, with bytes for the kinds that carry them. */
  onControl?: (from: string, message: ControlMessage, payload?: Uint8Array) => void;
  /** One encoded chunk from a peer. */
  onMedia?: (from: string, data: ArrayBuffer) => void;
  /** Retained desired source state, delivered only to a selected scoring device. */
  onSourceState?: (message: MediaSourceStateMessage) => void;
}

/**
 * What has arrived over the links, kept only in a build that allows the e2e seam.
 *
 * A peer connection is the one part of this app whose behaviour cannot be read off the server or
 * the screen, so a test asserting that two devices actually exchanged something has nowhere else to
 * look. Bounded, and never allocated at all in a shipped bundle.
 */
export interface Inbox {
  control: { from: string; data: unknown }[];
  media: { from: string; bytes: Uint8Array }[];
}

const INBOX_LIMIT = 200;

export function useMediaMesh(
  send: (msg: object) => void,
  connected: boolean,
  { tier, matchId, declarationVersion = 0, boardCamera = null, onControl, onMedia, onSourceState }: Options,
): MediaMesh {
  // Held in the shared store rather than here, because the readers are not all React — see
  // lib/appConfig.ts. This hook is only the one that receives it.
  const config = useMediaConfig();
  const [selfId, setSelfId] = useState<string | null>(null);
  const [session, setSession] = useState<MediaMesh['session']>(null);
  const [links, setLinks] = useState<MeshLink[]>([]);
  const sessionRef = useRef<MediaMesh['session']>(null);
  const selfRef = useRef<string | null>(null);

  const meshRef = useRef<Mesh | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const handlersRef = useRef({ onControl, onMedia, onSourceState });
  handlersRef.current = { onControl, onMedia, onSourceState };

  // Read once. `e2eEnabled()` reads the query string, and react-router drops it the moment the app
  // navigates, so asking later would answer no.
  const tapping = useRef(e2eEnabled()).current;
  const inbox = useRef<Inbox>({ control: [], media: [] });

  const frontend = matchId !== undefined;
  const active = Boolean(config?.enabled) && tier !== 'disabled' && connected
    && (!frontend || Boolean(matchId));

  // Rebuilt only when the ICE configuration itself changes, which in practice means once. A mesh
  // that was recreated on every render would drop every link it held.
  const iceSignature = JSON.stringify(config?.iceServers ?? []);
  const mesh = useMemo(() => {
    if (!config?.enabled) return null;
    return createMesh({
      iceServers: config.iceServers,
      video: config.video,
      signal: (to, description) => sendRef.current({ type: 'media_signal', to, description }),
      onChange: () => setLinks(meshRef.current?.links() ?? []),
      onControl: (from, message, payload) => {
        if (tapping) inbox.current.control = [...inbox.current.control, { from, data: message }].slice(-INBOX_LIMIT);
        handlersRef.current.onControl?.(from, message, payload);
      },
      onMedia: (from, data) => {
        if (tapping) {
          // Copied, because the buffer a datachannel hands over is not ours to keep.
          const bytes = new Uint8Array(data.slice(0));
          inbox.current.media = [...inbox.current.media, { from, bytes }].slice(-INBOX_LIMIT);
        }
        handlersRef.current.onMedia?.(from, data);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.enabled, iceSignature]);

  meshRef.current = mesh;

  const handleMessage = useCallback((msg: ServerMessage): void => {
    switch (msg.type) {
      case 'app_config':
        setAppConfig({ frontend: msg.frontend, scorer: msg.scorer, media: msg.media });
        break;
      case 'media_peers':
        if (sessionRef.current?.meshId !== msg.meshId || selfRef.current !== msg.self) {
          meshRef.current?.closeAll();
        }
        sessionRef.current = { matchId: msg.matchId, meshId: msg.meshId, setupComplete: msg.setupComplete };
        selfRef.current = msg.self;
        setSession(sessionRef.current);
        setSelfId(msg.self);
        meshRef.current?.setRoster(msg.peers as MediaPeer[]);
        break;
      case 'media_signal':
        meshRef.current?.deliver(msg.from, msg.description);
        break;
      case 'media_source_state':
        handlersRef.current.onSourceState?.(msg);
        break;
    }
  }, []);

  /**
   * Announce on every connection rather than once, for the same reason `scorer_hello` and
   * `activate_devices` do: the server keeps nothing across a socket, so a reconnect is exactly when
   * this matters. It also mints a new peer id, which is why the links from the old one go.
   */
  useEffect(() => {
    if (!config?.enabled || !connected) {
      mesh?.closeAll();
      setSelfId(null);
      selfRef.current = null;
      setSession(null);
      sessionRef.current = null;
      return;
    }
    if (frontend) {
      if (!matchId) {
        mesh?.closeAll();
        setSelfId(null);
        selfRef.current = null;
        setSession(null);
        sessionRef.current = null;
        return;
      }
      if (tier === 'disabled') {
        mesh?.closeAll();
        setSelfId(null);
        selfRef.current = null;
        setSession(null);
        sessionRef.current = null;
      }
      sendRef.current({ type: 'media_join', matchId, tier, boardCamera: tier === 'disabled' ? null : boardCamera });
    } else {
      if (tier === 'disabled') {
        mesh?.closeAll();
        setSelfId(null);
        selfRef.current = null;
      }
      sendRef.current({ type: 'media_ready', tier });
    }
  }, [config?.enabled, connected, frontend, matchId, declarationVersion, tier, boardCamera, mesh]);

  useEffect(() => () => { meshRef.current?.closeAll(); }, []);

  const refresh = useCallback(() => setLinks(meshRef.current?.links() ?? []), []);

  return { handleMessage, config, active, selfId, session, links, mesh, refresh, inbox: inbox.current };
}
