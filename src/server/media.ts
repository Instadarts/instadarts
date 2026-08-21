// Match-scoped media coordination.
//
// The server never joins the WebRTC data plane. It owns only the desired topology, source intent,
// and the opaque identities that make signaling and consent unable to cross a match boundary.

import type { WebSocket } from 'ws';
import type { MatchState } from '../shared/types';
import { boardsOf } from '../shared/types';
import type { MediaPeer, MediaRole, MediaTier } from '../shared/media';
import type { MediaFeature } from '../shared/settings';
import { MAX_SDP_BYTES, videoProfile } from '../shared/media';
import { INTERNAL_ICE } from '../shared/config';
import { CONFIG } from './config';
import { MEDIA_PEERS_PER_PEER, MEDIA_VIEWERS_PER_ROOM } from './capacity';
import { allClients, getClient, send } from './connections';
import { ownerOf, setDeviceMediaTier } from './devices';
import { getMatch } from './store';
import { meshEligible } from './match';
import { getMode } from './modes/types';
import { publishDevicesState } from './scoringDevices';
import { startStunServer } from './stun';
import { validateSignal } from './validation';
import { QUIET } from './env';

const MEDIA_ENABLED = CONFIG.media.enabled;

let stunPort: number | null = null;

export async function startInternalStun(): Promise<void> {
  if (!MEDIA_ENABLED || !CONFIG.media.iceUrls.includes(INTERNAL_ICE)) return;
  const server = await startStunServer(CONFIG.media.stunPort);
  if (server.port === null) {
    console.warn(`STUN: could not listen on UDP ${CONFIG.media.stunPort} — ${server.problem}`);
    console.warn('  Peers will use host candidates only, as if "internal" were not configured.');
    return;
  }
  stunPort = server.port;
  if (!QUIET) console.log(`STUN: UDP ${server.port} (must be reachable from clients)`);
}

interface SourceSlot {
  deviceId: string | null;
  sourcePeerId: string | null;
  sourceEpoch: string | null;
  socket: WebSocket | null;
}

interface MatchMediaSession {
  matchId: string;
  meshId: string;
  /** One per board in play — see `boardSlotsOf`. Immutable for the life of the session. */
  participantSlots: Set<string>;
  declarations: Set<string>;
  sources: Map<string, SourceSlot>;
  /**
   * What this match's game mode declined. Read from the mode once, when the session is made: a
   * match never changes mode, so asking again could only ever produce the same answer or drift.
   */
  bans: readonly MediaFeature[];
}

interface FrontendJoin {
  matchId: string;
  tier: MediaTier;
  slotId: string | null;
  spectator: boolean;
}

interface PeerBinding {
  matchId: string;
  meshId: string;
  peerId: string;
}

const sessions = new Map<string, MatchMediaSession>();
const frontendJoins = new Map<WebSocket, FrontendJoin>();
const deviceTiers = new Map<WebSocket, MediaTier>();
const bindings = new Map<WebSocket, PeerBinding>();
const published = new Map<WebSocket, string>();

function blankSource(): SourceSlot {
  return { deviceId: null, sourcePeerId: null, sourceEpoch: null, socket: null };
}

/** Create the one media incarnation belonging to this match. Lobbies never call this. */
export function startMediaForMatch(match: MatchState): void {
  if (!MEDIA_ENABLED || match.status !== 'in_progress') return;
  finishMediaForMatch(match.id);
  // More than two boards is a mesh nobody has designed. No session at all is a state every client
  // path already handles — it is what a deployment with media switched off produces.
  if (!meshEligible(match)) return;
  // A slot is a **board**, not a player: a user holding two players has one camera watching one
  // dartboard, declares once, and publishes one feed that serves both of their turns. `boardsOf`
  // names them the same way `Player.boardId` does on the wire, so both sides agree by construction.
  const slots = new Set(boardsOf(match.players));
  sessions.set(match.id, {
    matchId: match.id,
    meshId: crypto.randomUUID(),
    participantSlots: slots,
    declarations: new Set(),
    sources: new Map([...slots].map((slot) => [slot, blankSource()])),
    // A mode this build does not have bans nothing, which is the same answer as a mode that
    // declared nothing. Neither is a reason to withhold a feature.
    bans: getMode(match.settings.mode)?.bansMedia ?? [],
  });
}

/** End source intent, publish teardown, and forget every identity immediately. */
export function finishMediaForMatch(matchId: string): void {
  const session = sessions.get(matchId);
  if (!session) return;
  for (const source of session.sources.values()) deactivateSource(session, source);
  for (const [ws, binding] of [...bindings]) {
    if (binding.matchId !== matchId) continue;
    send(ws, {
      type: 'media_peers', matchId, meshId: session.meshId, setupComplete: true,
      self: binding.peerId, peers: [],
    });
    bindings.delete(ws);
    published.delete(ws);
  }
  for (const [ws, join] of [...frontendJoins]) {
    if (join.matchId === matchId) frontendJoins.delete(ws);
  }
  sessions.delete(matchId);
}

export function mediaPeerCount(): number {
  return bindings.size;
}

function ensureBinding(ws: WebSocket, session: MatchMediaSession): PeerBinding {
  const current = bindings.get(ws);
  if (current?.matchId === session.matchId && current.meshId === session.meshId) return current;
  if (current) published.delete(ws);
  const binding = { matchId: session.matchId, meshId: session.meshId, peerId: crypto.randomUUID() };
  bindings.set(ws, binding);
  return binding;
}

function removeBinding(ws: WebSocket): string | null {
  const matchId = bindings.get(ws)?.matchId ?? null;
  bindings.delete(ws);
  published.delete(ws);
  return matchId;
}

/** Remove only the live endpoint. Participant source intent belongs to the match, not this socket. */
export function releaseMediaState(ws: WebSocket): void {
  const affected = new Set<string>();
  const bindingMatch = removeBinding(ws);
  if (bindingMatch) affected.add(bindingMatch);
  const join = frontendJoins.get(ws);
  if (join) affected.add(join.matchId);
  frontendJoins.delete(ws);

  if (deviceTiers.has(ws)) {
    deviceTiers.delete(ws);
    for (const session of sessions.values()) {
      for (const source of session.sources.values()) {
        if (source.socket === ws) affected.add(session.matchId);
      }
    }
  }
  for (const matchId of affected) publishSession(matchId);
}

interface Participant {
  ws: WebSocket;
  peerId: string;
  kind: 'user' | 'device';
  spectator: boolean;
  slotId: string | null;
  tier: Exclude<MediaTier, 'disabled'>;
  playerId?: string;
}

interface Pairing { a: Participant; b: Participant }

function slotForFrontend(match: MatchState, client: NonNullable<ReturnType<typeof getClient>>): string | null {
  if (client.isSpectator) return null;
  return match.players.find((candidate) => candidate.sessionId === client.sessionId)?.id ?? null;
}

function scorerSocket(deviceId: string): WebSocket | null {
  for (const [ws, client] of allClients()) {
    if (client.deviceId === deviceId) return ws;
  }
  return null;
}

/**
 * Who a board's feed may be offered to.
 *
 * Everyone at another board, and the audience. A match with one board has nobody at another, so it
 * is offered to spectators alone — which is what stops a single shared board becoming self-video,
 * and is derived here rather than declared, because "is there anyone else" is a fact about the
 * slots and not about how the match was created.
 */
function audienceFor(session: MatchMediaSession): MediaRole[] {
  return session.participantSlots.size > 1 ? ['opponent', 'spectator'] : ['spectator'];
}

function deactivateSource(session: MatchMediaSession, source: SourceSlot): void {
  if (source.socket) {
    send(source.socket, {
      type: 'media_source_state', matchId: session.matchId, meshId: session.meshId, active: false,
    });
  }
  source.sourcePeerId = null;
  source.sourceEpoch = null;
  source.socket = null;
}

function syncSource(session: MatchMediaSession, source: SourceSlot, participant?: Participant): void {
  // A mode that declined board video is refused here rather than anywhere further down: no active
  // directive means the camera never mints a feed id and never offers one, so nothing to decline
  // and nothing encoded. The device keeps its place in every roster, which is what leaves stills,
  // director commands and the owner's own link working.
  const wanted = !session.bans.includes('boardVideo');
  const active = wanted && participant?.kind === 'device' && participant.tier === 'video';
  if (!active || !source.deviceId) {
    if (source.sourceEpoch || source.socket) deactivateSource(session, source);
    return;
  }
  if (source.sourcePeerId !== participant.peerId || source.socket !== participant.ws || !source.sourceEpoch) {
    if (source.socket && source.socket !== participant.ws) deactivateSource(session, source);
    source.sourcePeerId = participant.peerId;
    source.sourceEpoch = crypto.randomUUID();
    source.socket = participant.ws;
  }
  send(participant.ws, {
    type: 'media_source_state', matchId: session.matchId, meshId: session.meshId,
    active: true, sourceEpoch: source.sourceEpoch, audience: audienceFor(session),
  });
}

function planFor(session: MatchMediaSession): { participants: Participant[]; pairs: Pairing[] } {
  const match = getMatch(session.matchId);
  if (!match || match.status !== 'in_progress') return { participants: [], pairs: [] };

  const users: Participant[] = [];
  const spectators: Participant[] = [];
  const devices: Participant[] = [];

  for (const [ws, join] of frontendJoins) {
    if (join.matchId !== session.matchId || join.tier === 'disabled') continue;
    const client = getClient(ws);
    if (!client || client.deviceId || client.matchId !== session.matchId) continue;
    const binding = ensureBinding(ws, session);
    const peer: Participant = {
      ws, peerId: binding.peerId, kind: 'user', spectator: join.spectator,
      slotId: join.slotId, tier: join.tier as Exclude<MediaTier, 'disabled'>,
    };
    if (join.slotId) {
      const player = match.players.find((candidate) => candidate.id === join.slotId);
      if (player) peer.playerId = player.id;
    }
    (join.spectator ? spectators : users).push(peer);
  }

  for (const [slotId, source] of session.sources) {
    if (!source.deviceId) { syncSource(session, source); continue; }
    const ws = scorerSocket(source.deviceId);
    const tier = ws ? deviceTiers.get(ws) ?? 'disabled' : 'disabled';
    if (!ws || tier === 'disabled') { syncSource(session, source); continue; }
    const binding = ensureBinding(ws, session);
    const device: Participant = {
      ws, peerId: binding.peerId, kind: 'device', spectator: false, slotId,
      tier: tier as Exclude<MediaTier, 'disabled'>,
    };
    const player = match.players.find((candidate) => candidate.id === slotId);
    if (player) device.playerId = player.id;
    devices.push(device);
    syncSource(session, source, device);
  }

  const admitted = spectators.slice(0, MEDIA_VIEWERS_PER_ROOM);
  const pairs: Pairing[] = [];
  const degree = new Map<string, number>();
  const pair = (a: Participant, b: Participant): void => {
    const da = degree.get(a.peerId) ?? 0;
    const db = degree.get(b.peerId) ?? 0;
    if (da >= MEDIA_PEERS_PER_PEER || db >= MEDIA_PEERS_PER_PEER) return;
    degree.set(a.peerId, da + 1);
    degree.set(b.peerId, db + 1);
    pairs.push({ a, b });
  };

  for (const device of devices) {
    const owner = users.find((user) => user.slotId === device.slotId);
    if (owner) pair(device, owner);
  }
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) pair(users[i], users[j]);
  }
  for (const device of devices) {
    for (const user of users) if (user.slotId !== device.slotId) pair(device, user);
  }
  for (const spectator of admitted) for (const user of users) pair(spectator, user);
  for (const spectator of admitted) for (const device of devices) pair(spectator, device);

  return { participants: [...users, ...admitted, ...devices], pairs };
}

function rosterFor(self: Participant, pairs: Pairing[]): MediaPeer[] {
  const roster: MediaPeer[] = [];
  for (const { a, b } of pairs) {
    const other = a.peerId === self.peerId ? b : b.peerId === self.peerId ? a : null;
    if (!other) continue;
    const own = self.slotId !== null && self.slotId === other.slotId && self.kind !== other.kind;
    roster.push({
      peerId: other.peerId,
      kind: other.kind,
      tier: other.tier,
      own,
      role: own ? 'owner' : other.spectator ? 'spectator' : 'opponent',
      ...(other.playerId ? { playerId: other.playerId } : {}),
      polite: self.peerId < other.peerId,
      send: !other.spectator && self.kind !== 'device',
      recv: other.kind !== 'device' && !self.spectator,
    });
  }
  return roster;
}

function publishSession(matchId: string): void {
  const session = sessions.get(matchId);
  if (!session) return;
  const { participants, pairs } = planFor(session);
  const present = new Set(participants.map((peer) => peer.ws));
  const setupComplete = [...session.participantSlots].every((slot) => session.declarations.has(slot));

  for (const participant of participants) {
    const peers = rosterFor(participant, pairs);
    const signature = JSON.stringify([session.matchId, session.meshId, setupComplete, participant.peerId, peers]);
    if (published.get(participant.ws) === signature) continue;
    published.set(participant.ws, signature);
    send(participant.ws, {
      type: 'media_peers', matchId: session.matchId, meshId: session.meshId,
      setupComplete, self: participant.peerId, peers,
    });
  }

  for (const [ws, binding] of [...bindings]) {
    if (binding.matchId !== matchId || present.has(ws)) continue;
    send(ws, {
      type: 'media_peers', matchId, meshId: session.meshId, setupComplete,
      self: binding.peerId, peers: [],
    });
    removeBinding(ws);
  }
}

export function mediaRoomOf(ws: WebSocket): string | null {
  return bindings.get(ws)?.matchId ?? frontendJoins.get(ws)?.matchId ?? getClient(ws)?.matchId ?? null;
}

export function publishMediaFor(ws: WebSocket, previousMatch?: string | null): void {
  if (!MEDIA_ENABLED) return;
  if (previousMatch) publishSession(previousMatch);
  const current = getClient(ws)?.matchId;
  if (current && current !== previousMatch) publishSession(current);
  if (getClient(ws)?.deviceId) for (const matchId of sessions.keys()) publishSession(matchId);
}

export function publishMediaForRoom(matchId: string): void {
  publishSession(matchId);
}

export function sendAppConfig(ws: WebSocket): void {
  send(ws, {
    type: 'app_config',
    frontend: CONFIG.frontend,
    scorer: CONFIG.scorer,
    media: {
      enabled: MEDIA_ENABLED,
      setupTimeoutMs: CONFIG.media.setupTimeoutMs,
      iceServers: CONFIG.media.iceUrls
        .filter((urls) => urls !== INTERNAL_ICE || stunPort !== null)
        .map((urls) => ({ urls })),
      stunPort,
      virtualCamera: CONFIG.media.virtualCamera,
      maxPeers: MEDIA_PEERS_PER_PEER,
      still: CONFIG.media.still,
      video: videoProfile(CONFIG.media.video),
      dartEvidence: CONFIG.media.dartEvidence,
    },
  });
}

/** Device capability announcement. It creates no identity until a running match selects it. */
export function handleMediaReady(ws: WebSocket, msg: any): void {
  if (!MEDIA_ENABLED) return;
  const tier = validateTier(msg.tier);
  deviceTiers.set(ws, tier);
  const client = getClient(ws);
  if (client?.deviceId) noteDeviceTier(client.deviceId, tier);
  for (const matchId of sessions.keys()) publishSession(matchId);
}

function validateTier(raw: unknown): MediaTier {
  return raw === 'video' || raw === 'stills' ? raw : 'disabled';
}

function noteDeviceTier(deviceId: string, tier: MediaTier): void {
  setDeviceMediaTier(deviceId, tier);
  const owner = ownerOf(deviceId);
  if (owner) publishDevicesState(owner);
}

export function syncDeviceTier(ws: WebSocket): void {
  if (!MEDIA_ENABLED) return;
  const client = getClient(ws);
  const tier = deviceTiers.get(ws);
  if (client?.deviceId && tier) noteDeviceTier(client.deviceId, tier);
  for (const matchId of sessions.keys()) publishSession(matchId);
}

export function handleMediaLeave(ws: WebSocket): void {
  const client = getClient(ws);
  if (client?.deviceId) {
    noteDeviceTier(client.deviceId, 'disabled');
    deviceTiers.set(ws, 'disabled');
    removeBinding(ws);
    for (const matchId of sessions.keys()) publishSession(matchId);
    return;
  }
  const join = frontendJoins.get(ws);
  const session = join ? sessions.get(join.matchId) : undefined;
  if (!join || !session) return;
  join.tier = 'disabled';
  if (join.slotId) {
    const source = session.sources.get(join.slotId)!;
    deactivateSource(session, source);
    source.deviceId = null;
  }
  removeBinding(ws);
  publishSession(session.matchId);
}

/** An explicit unclaim/unpair is permanent source withdrawal, unlike a frontend socket loss. */
export function withdrawMediaDevice(deviceId: string): void {
  for (const session of sessions.values()) {
    let changed = false;
    for (const source of session.sources.values()) {
      if (source.deviceId !== deviceId) continue;
      deactivateSource(session, source);
      source.deviceId = null;
      changed = true;
    }
    if (changed) publishSession(session.matchId);
  }
}

/**
 * A claim transferred to the reloaded holder of the same immutable source slot preserves intent;
 * transfer anywhere else is permanent withdrawal from the old match.
 */
export function revalidateMediaDeviceOwner(deviceId: string, newOwnerSessionId: string): void {
  for (const session of sessions.values()) {
    const match = getMatch(session.matchId);
    if (!match) continue;
    let changed = false;
    for (const [slotId, source] of session.sources) {
      if (source.deviceId !== deviceId) continue;
      const stillOwnsSlot =
        match.players.find((player) => player.id === slotId)?.sessionId === newOwnerSessionId;
      if (stillOwnsSlot) continue;
      deactivateSource(session, source);
      source.deviceId = null;
      changed = true;
    }
    if (changed) publishSession(session.matchId);
  }
}

/** Idempotent frontend declaration, accepted only for its current running match. */
export function handleMediaJoin(ws: WebSocket, msg: any): void {
  if (!MEDIA_ENABLED || typeof msg.matchId !== 'string') return;
  const client = getClient(ws);
  const match = getMatch(msg.matchId);
  const session = sessions.get(msg.matchId);
  if (!client || client.deviceId || client.matchId !== msg.matchId || !match || !session || match.status !== 'in_progress') return;

  const tier = validateTier(msg.tier);
  const slotId = slotForFrontend(match, client);
  if (!client.isSpectator && !slotId) return;
  if (slotId) session.declarations.add(slotId);
  frontendJoins.set(ws, { matchId: match.id, tier, slotId, spectator: client.isSpectator });
  if (tier === 'disabled') removeBinding(ws);
  else ensureBinding(ws, session);

  if (slotId) {
    const source = session.sources.get(slotId)!;
    const requested = tier === 'disabled' ? null : msg.boardCamera;
    // The current source was already validated for this immutable participant slot. A replacement
    // frontend may re-declare that exact choice before activate_devices has moved the transient
    // claim to its new session id; clearing it in that window would stop an otherwise healthy
    // scorer and lose every unaffected recipient's feed. Only the existing choice gets this
    // treatment — a new or different camera still has to be owned right now.
    const valid = typeof requested === 'string'
      && (source.deviceId === requested || ownerOf(requested) === client.sessionId)
      ? requested
      : null;
    if (source.deviceId !== valid) {
      deactivateSource(session, source);
      source.deviceId = valid;
    }
  }
  publishSession(match.id);
}

export function handleMediaSignal(ws: WebSocket, msg: any): void {
  if (!MEDIA_ENABLED || typeof msg.to !== 'string') return;
  const binding = bindings.get(ws);
  const session = binding ? sessions.get(binding.matchId) : undefined;
  if (!binding || !session || binding.meshId !== session.meshId) return;
  const description = validateSignal(msg.description);
  if (!description) return;

  const { participants, pairs } = planFor(session);
  const paired = pairs.some(({ a, b }) =>
    (a.peerId === binding.peerId && b.peerId === msg.to) ||
    (b.peerId === binding.peerId && a.peerId === msg.to));
  if (!paired) return;
  const target = participants.find((peer) => peer.peerId === msg.to);
  if (target) send(target.ws, { type: 'media_signal', from: binding.peerId, description });
}

export { MAX_SDP_BYTES };
