// The media feature's one hook, mounted by the gaming frontend and the scoring device alike.
//
// Both apps own a socket already, and neither owns it in a way the other can use — so this takes a
// `send` and is fed the frames the app receives, exactly as useScoringDevices does. What it holds is
// a mesh, which holds the links.
//
// Three conditions have to hold before this connection announces itself, and they are independent:
// the deployment allows media (`media_config`), this browser or phone wants it (the `enabled`
// argument), and there is a socket to announce over. Announcing is what puts a connection in other
// peers' rosters; there is no other way in, and no other way out.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ServerMessage } from '../../shared/protocol';
import type { MediaConfig, MediaPeer, MediaTier } from '../../shared/media';
import { DEFAULT_VIDEO_PROFILE } from '../../shared/media';
import { createMesh, type Mesh, type MeshLink } from '../media/mesh';
import { e2eEnabled } from '../lib/e2e';

export interface MediaMesh {
  /** Feed every server frame here, before or after the app's own handling. */
  handleMessage: (msg: ServerMessage) => void;
  /** What the deployment allows. Null until it has said. */
  config: MediaConfig | null;
  /** Whether this connection is taking part: the deployment, the preference and the socket all agreeing. */
  active: boolean;
  /** This connection's own peer id, once the server has minted one. */
  selfId: string | null;
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
  /**
   * The device this frontend is showing as its board, or null for none. Ignored by a scoring
   * device, which has no cameras of its own to nominate.
   *
   * Re-sent on every connect, like `activate_devices`, since the server keeps nothing across one.
   */
  boardCamera?: string | null;
  /** A control-channel message from a peer. */
  onControl?: (from: string, data: unknown) => void;
  /** One encoded chunk from a peer. */
  onMedia?: (from: string, data: ArrayBuffer) => void;
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
  { tier, boardCamera = null, onControl, onMedia }: Options,
): MediaMesh {
  const [config, setConfig] = useState<MediaConfig | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [links, setLinks] = useState<MeshLink[]>([]);

  const meshRef = useRef<Mesh | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const handlersRef = useRef({ onControl, onMedia });
  handlersRef.current = { onControl, onMedia };

  // Read once. `e2eEnabled()` reads the query string, and react-router drops it the moment the app
  // navigates, so asking later would answer no.
  const tapping = useRef(e2eEnabled()).current;
  const inbox = useRef<Inbox>({ control: [], media: [] });

  const active = Boolean(config?.enabled) && tier !== 'disabled' && connected;

  // Rebuilt only when the ICE configuration itself changes, which in practice means once. A mesh
  // that was recreated on every render would drop every link it held.
  const iceSignature = JSON.stringify(config?.iceServers ?? []);
  const mesh = useMemo(() => {
    if (!config?.enabled) return null;
    return createMesh({
      iceServers: config.iceServers,
      video: config.video ?? DEFAULT_VIDEO_PROFILE,
      signal: (to, description) => sendRef.current({ type: 'media_signal', to, description }),
      onChange: () => setLinks(meshRef.current?.links() ?? []),
      onControl: (from, data) => {
        if (tapping) inbox.current.control = [...inbox.current.control, { from, data }].slice(-INBOX_LIMIT);
        handlersRef.current.onControl?.(from, data);
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
      case 'media_config':
        setConfig({
          enabled: msg.enabled,
          iceServers: msg.iceServers,
          video: msg.video,
          maxPeers: msg.maxPeers,
        });
        break;
      case 'media_peers':
        setSelfId(msg.self);
        meshRef.current?.setRoster(msg.peers as MediaPeer[]);
        break;
      case 'media_signal':
        meshRef.current?.deliver(msg.from, msg.description);
        break;
    }
  }, []);

  /**
   * Announce on every connection rather than once, for the same reason `scorer_hello` and
   * `activate_devices` do: the server keeps nothing across a socket, so a reconnect is exactly when
   * this matters. It also mints a new peer id, which is why the links from the old one go.
   */
  useEffect(() => {
    if (!active) {
      mesh?.closeAll();
      setSelfId(null);
      return;
    }
    // Carries the tier, so a phone switched from stills to video says so without reconnecting. The
    // server keeps the peer id it already had — a new one would tear down a live link.
    sendRef.current({ type: 'media_ready', tier });
  }, [active, mesh, tier]);

  /**
   * Which board this frontend is showing, restated on every connect and whenever it changes.
   *
   * Sent even when it is null: "nobody" is an answer the server has to hear, because it is what
   * takes the opponent's view away.
   */
  useEffect(() => {
    if (!active) return;
    sendRef.current({ type: 'media_select_camera', deviceId: boardCamera });
  }, [active, boardCamera]);

  /**
   * Say so when the preference is switched off while connected — a peer that merely goes quiet stays
   * in everyone's roster, and they would sit waiting on a link it is never going to answer.
   */
  const wasEnabled = useRef(tier !== 'disabled');
  useEffect(() => {
    const enabled = tier !== 'disabled';
    if (wasEnabled.current && !enabled && connected && config?.enabled) {
      sendRef.current({ type: 'media_leave' });
    }
    wasEnabled.current = enabled;
  }, [tier, connected, config?.enabled]);

  useEffect(() => () => { meshRef.current?.closeAll(); }, []);

  const refresh = useCallback(() => setLinks(meshRef.current?.links() ?? []), []);

  return { handleMessage, config, active, selfId, links, mesh, refresh, inbox: inbox.current };
}
