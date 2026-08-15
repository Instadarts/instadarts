// The media half of the socket layer: who may open a peer connection to whom, and the relaying of
// the two messages it takes to open one.
//
// A third sibling to the gameplay handlers in wsHandler.ts and the scoring-device handlers in
// scoringDevices.ts. Like them it is built on connections.ts and shares nothing else with either.
//
// ## The whole security model, in one sentence
//
// **The roster is the authorization.** The server computes, for each peer, the set of peers it may
// talk to, publishes exactly that, and relays a signal only between two peers that appear in each
// other's roster — recomputed at the moment the message arrives, never remembered. There is no other
// rule, no session token and no room password, because there is nothing else to check: a peer either
// is somewhere the server put it, or it is not.
//
// ## The two gates on a board camera
//
// A scoring device is offered to anybody only when its **phone is willing** (its own `MediaTier`,
// set on the device) and its **owner has nominated it** as the board camera. The two belong to
// different people on purpose: a phone can be permanently opted in without being permanently
// watchable, and an owner can take the opponent's view away without touching a setting on a phone in
// another room. Exactly one device per frontend may be nominated, or none — and that one picture is
// the owner's board offered to opponents and spectators.
//
// ## Nothing here outlives a socket
//
// Four small maps — peer ids, tiers, board-camera choices, and what each peer was last told. No room
// objects, no link table, no timers, nothing to expire and nothing to collect, which is how this
// obeys "a deadline is the only way anything is reclaimed" without owning a deadline: it holds
// nothing that needs one. Every entry is keyed by a live socket or a live session and goes when it
// does; a client re-states its tier and its choice on each connect, exactly as it re-states its
// device claims.
//
// Rooms and rosters are **derived on demand** from the client registry, exactly as
// `resolveScoringTarget` and `devicesScoringInto` already are. That costs a scan of the connections
// in a room whenever somebody moves, and buys a feature that cannot leak.

import type { WebSocket } from 'ws';
import type { MediaPeer, MediaTier } from '../shared/media';
import type { Client } from './types';
import { MAX_SDP_BYTES, videoProfile } from '../shared/media';
import { INTERNAL_ICE } from '../shared/config';
import { CONFIG } from './config';
import { MEDIA_PEERS_PER_PEER, MEDIA_VIEWERS_PER_ROOM } from './capacity';

// Read once, and named locally because whether this deployment carries media is asked at the top of
// nearly every handler below.
const MEDIA_ENABLED = CONFIG.media.enabled;
import { allClients, getClient, send } from './connections';
import { publishDevicesState } from './scoringDevices';
import { devicesForSession, ownerOf, setDeviceMediaTier } from './devices';
import { getLobby, getMatch } from './store';
import { startStunServer } from './stun';
import { validateSignal } from './validation';
import { QUIET } from './env';

// ============================================================
// The STUN server this deployment carries
// ============================================================

/**
 * The port to tell clients about, or null.
 *
 * Null covers both "nobody asked for one" and "one was asked for and could not be started", which
 * are the same thing to a client: there is nothing at that port, so it must not be sent there. It is
 * the *only* record of that — `sendAppConfig` drops the `internal` entry alongside it, so the two
 * cannot come apart.
 */
let stunPort: number | null = null;

/**
 * Bring up the internal STUN server, if this deployment asked for one.
 *
 * Called once at boot and never again. Failure is reported and survived: a UDP port that will not
 * bind costs the reflexive candidate, which is an optional part of an optional feature, and is not a
 * reason to refuse to serve darts.
 */
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

// ============================================================
// Who is taking part
// ============================================================

/**
 * The peer id of every connection that has opted in. Absent means "not taking part", which is both
 * how a client opts out and how a deployment with the feature off looks from in here.
 *
 * Keyed by socket rather than stored on `Client`, for the same reason `deviceSockets` is: the
 * registry describes a connection's place in a match, and this describes a feature it volunteered
 * for. Also it means `Client` — and the seven places that construct one — stay exactly as they were.
 */
const peerIds = new Map<WebSocket, string>();

/**
 * How much each peer says it is willing to send.
 *
 * Keyed by socket, because it is the live connection that announced it — a device with no socket
 * cannot be a peer whatever a registry remembers. A device's tier is *also* copied into the device
 * registry, but only so its owner's list can display it; this map is the one the plan reads.
 */
const tiers = new Map<WebSocket, MediaTier>();

/**
 * What each peer was last told, and about which room.
 *
 * The signature is what lets the publish hook be called liberally: an unchanged roster sends
 * nothing. A re-match in particular moves every client to a new match id while changing nothing
 * about who is in the room, and the whole point is that it costs one derivation and no traffic, and
 * does not disturb a link that is carrying video.
 *
 * The room is remembered rather than recomputed because of the order things happen in on the way
 * out: by the time a departing connection can be tidied up, it has already been moved off whatever
 * it was in, and there would be no way left to ask where it had been.
 */
interface Published {
  room: string;
  signature: string;
}
const published = new Map<WebSocket, Published>();

/** Who was last told about each room, so a room that empties can tell the people who left it. */
const roomMembers = new Map<string, Set<WebSocket>>();

/**
 * Which of its claimed devices each frontend has nominated as **the** board camera.
 *
 * At most one per session, and that one picture is the owner's board offered to remote viewers — so
 * "which board am I sharing" has a single answer rather than one per viewer.
 * Nominating nothing is a complete opt-out the opponent has no way around.
 *
 * The second of the two gates on a device (the phone's own willingness is the first), and like
 * everything else here it dies with the socket: a frontend re-sends its choice on every connect.
 */
const boardCameras = new Map<string, string>();

/** A connection giving up its place in the feature, however it came to. */
export function releaseMediaState(ws: WebSocket): void {
  // Cleared whether or not this connection was ever a peer: a frontend nominates a board camera
  // from its own session, and that session is about to stop existing.
  const client = getClient(ws);
  if (client && !client.deviceId) boardCameras.delete(client.sessionId);

  if (!peerIds.has(ws)) return;
  const last = published.get(ws)?.room;
  peerIds.delete(ws);
  tiers.delete(ws);
  published.delete(ws);
  // Everyone who could see it needs to hear that they no longer can — a roster is how a link learns
  // to close, and there is no goodbye message anywhere in this protocol.
  if (last) publishRoom(last);
}

/** How many connections are taking part, for /server-stats. */
export function mediaPeerCount(): number {
  return peerIds.size;
}

// ============================================================
// Rooms
// ============================================================

/**
 * Where a connection is, for the purposes of media: a lobby before the match, the match after.
 *
 * One space, because they are one thing at two moments — `broadcastToLobby` already treats the two
 * ids interchangeably for the same reason. A **scoring device** has no room of its own; it inherits
 * its owner's, which is what makes a device visible to the opponent exactly when its owner is.
 */
function roomOf(client: Client | undefined): string | null {
  if (!client) return null;
  if (!client.deviceId) return client.lobbyId ?? client.matchId;

  const owner = ownerOf(client.deviceId);
  if (!owner) return null;
  for (const [, other] of allClients()) {
    if (other.deviceId || other.sessionId !== owner) continue;
    return other.lobbyId ?? other.matchId;
  }
  return null;
}

/** Whether a room still exists. A room nobody can name is a room whose peers have nothing in common. */
function roomIsReal(room: string): boolean {
  return getLobby(room) !== undefined || getMatch(room) !== undefined;
}

// ============================================================
// The plan
// ============================================================

interface Participant {
  ws: WebSocket;
  client: Client;
  peerId: string;
  kind: 'user' | 'device';
  /** True for a frontend that is only watching. A spectator may receive and never send. */
  spectator: boolean;
  /** For a device, the session that holds it. For a user, its own session. */
  sessionId: string;
  /** The most this peer will send. Never `disabled`: such a peer is not in the plan at all. */
  tier: MediaTier;
  playerId?: string;
  label?: string;
}

/** An agreed pair, with the polite side already decided. Both rosters are built from these. */
interface Pairing {
  a: Participant;
  b: Participant;
}

/**
 * Everyone in a room who is taking part, and every pair among them — computed in one pass.
 *
 * Both endpoints of a pair come out of the same plan, which is the reason this is one function
 * rather than a per-peer question asked twice: two peers can never disagree about whether they are
 * paired, which of them is polite, or who may send to whom.
 */
function planFor(room: string): { participants: Participant[]; pairs: Pairing[] } {
  if (!MEDIA_ENABLED || !roomIsReal(room)) return { participants: [], pairs: [] };

  const users: Participant[] = [];
  const spectators: Participant[] = [];
  const devices: Participant[] = [];

  // Registry order is connection order — a Map keeps insertion order — so which spectators get in is
  // first-come, first-served and stable rather than arbitrary.
  for (const [ws, client] of allClients()) {
    const peerId = peerIds.get(ws);
    if (!peerId) continue;

    if (client.deviceId) {
      const owner = ownerOf(client.deviceId);
      if (!owner) continue;
      // **Both gates.** The phone must be willing to share, and its owner must have nominated this
      // one as the board camera. Either alone offers nobody anything — which is what lets a device
      // be permanently opted in without being permanently watchable, and lets an owner switch the
      // opponent's view off without touching a setting on a phone in another room.
      const tier = tiers.get(ws) ?? 'disabled';
      if (tier === 'disabled') continue;
      if (boardCameras.get(owner) !== client.deviceId) continue;
      devices.push({ ws, client, peerId, kind: 'device', spectator: false, sessionId: owner, tier });
      continue;
    }

    if ((client.lobbyId ?? client.matchId) !== room) continue;
    const participant: Participant = {
      ws, client, peerId, kind: 'user', spectator: client.isSpectator, sessionId: client.sessionId,
      tier: tiers.get(ws) ?? 'video',
    };
    (client.isSpectator ? spectators : users).push(participant);
  }

  // A device's room is its owner's, and its owner has to be in this one. Resolved against the users
  // already collected rather than by scanning again — and this is also what excludes a device whose
  // owner is a spectator, since a spectator with a paired camera must not become a publisher.
  const playing = new Set(users.map((u) => u.sessionId));
  const present = devices.filter((d) => playing.has(d.sessionId));
  for (const user of [...users, ...spectators]) describeUser(user, room);
  for (const device of present) describeDevice(device, users);

  const admitted = spectators.slice(0, MEDIA_VIEWERS_PER_ROOM);
  const degree = new Map<string, number>();
  const pairs: Pairing[] = [];

  /** Take a pair unless it would put either end over its cap. Capping here, while the list is being
   *  built, is what keeps the relation symmetric — truncating a finished roster per peer would leave
   *  one side offering a link the other side has never heard of. */
  const pair = (a: Participant, b: Participant): void => {
    const da = degree.get(a.peerId) ?? 0;
    const db = degree.get(b.peerId) ?? 0;
    if (da >= MEDIA_PEERS_PER_PEER || db >= MEDIA_PEERS_PER_PEER) return;
    degree.set(a.peerId, da + 1);
    degree.set(b.peerId, db + 1);
    pairs.push({ a, b });
  };

  // The priority order. What a peer at its cap loses is always the least valuable link, which is
  // why this is a written-down sequence rather than whatever order the loops happen to run in.
  //
  // Never device ↔ device: two phones pointed at two boards have nothing to say to each other.
  // Never spectator ↔ spectator: neither of them may send, so the link would carry nothing.

  // 1. A device and its own owner — the cheapest hop, and the one the owner most wants.
  for (const device of present) {
    const owner = users.find((u) => u.sessionId === device.sessionId);
    if (owner) pair(device, owner);
  }
  // 2. The two participants.
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) pair(users[i], users[j]);
  }
  // 3. A device and the opponent: watching the other board.
  for (const device of present) {
    for (const user of users) {
      if (user.sessionId !== device.sessionId) pair(device, user);
    }
  }
  // 4. and 5. The audience, last, because every one of them is another link on somebody's phone.
  for (const spectator of admitted) {
    for (const user of users) pair(spectator, user);
  }
  for (const spectator of admitted) {
    for (const device of present) pair(spectator, device);
  }

  return { participants: [...users, ...spectators, ...present], pairs };
}

/**
 * What to call a device, and whose board it is watching.
 *
 * The name is the device's own — it names itself, and the frontend that paired it only displays what
 * it is told. The player is its owner's, so a viewer can put a board beside the right card; it is
 * the same question `resolveScoringTarget` asks, and it has no answer in a local match for the same
 * reason, since one user holds every player there.
 */
function describeDevice(device: Participant, users: Participant[]): void {
  const view = devicesForSession(device.sessionId).find((d) => d.deviceId === device.client.deviceId);
  const owner = users.find((u) => u.sessionId === device.sessionId);
  device.label = view?.name || undefined;
  if (owner?.playerId) device.playerId = owner.playerId;
}

/**
 * What to call a user, and which player it is.
 *
 * Only answered where it is unambiguous. A local match's user holds every player, and a spectator
 * holds none, so both get a name and no player id.
 */
function describeUser(user: Participant, room: string): void {
  const match = getMatch(room);
  const lobby = getLobby(room);
  const players = match?.players ?? lobby?.players ?? [];
  const isLocal = match?.isLocal ?? lobby?.isLocal ?? false;

  const own = players.filter((p) => p.sessionId === user.sessionId);
  if (user.spectator || isLocal || own.length !== 1) {
    user.label = own.length > 0 ? own.map((p) => p.name).join(' & ') : undefined;
    return;
  }
  user.playerId = own[0].id;
  user.label = own[0].name;
}

/**
 * A peer's roster: everyone it was paired with, as it should see them.
 *
 * `polite` is decided by comparing the two ids, so the answer is opposite on the two sides without
 * either side having to work anything out. The impolite side is also the one that opens the
 * datachannels and therefore offers first, which is what stops a link's first negotiation from
 * colliding with itself.
 */
function rosterFor(self: Participant, pairs: Pairing[]): MediaPeer[] {
  const roster: MediaPeer[] = [];
  for (const { a, b } of pairs) {
    const other = a.peerId === self.peerId ? b : b.peerId === self.peerId ? a : null;
    if (!other) continue;
    // The ownership edge, stated to both ends: a device and the frontend that claimed it share a
    // session id, and nobody else in the room does. It is what lets a device refuse a command from
    // an opponent, and what lets a frontend pick its own board camera out of a list of opaque ids.
    // Exactly one of the pair is a device, so this can never be true between two frontends.
    const own = other.kind !== self.kind && other.sessionId === self.sessionId;
    roster.push({
      peerId: other.peerId,
      kind: other.kind,
      tier: other.tier,
      own,
      // What kind of viewer this peer is, which is what a camera addresses a still or a feed to.
      // Sharing `own`'s terms rather than restating them, and testing it first: the two cannot
      // conflict, because planFor already refuses to offer a device whose owner is a spectator.
      //
      // This is the one thing in the roster a client could not work out for itself — nothing else in
      // it says who is only watching.
      role: own ? 'owner' : other.spectator ? 'spectator' : 'opponent',
      ...(other.playerId ? { playerId: other.playerId } : {}),
      ...(other.label ? { label: other.label } : {}),
      polite: self.peerId < other.peerId,
      // Two rules, each stated from both ends so the two sides always agree. A spectator watches
      // and nothing else. A scoring device is the mirror image: it is a board camera, so it sends
      // and never receives — it has no business decoding anybody's picture, and saying so here is
      // what keeps a decoder off a phone that is already running a detection model.
      //
      // Both are about *media*. The control channel is open in both directions regardless, or a
      // accepted viewer could not ask a camera for a keyframe.
      send: !other.spectator && self.kind !== 'device',
      recv: other.kind !== 'device' && !self.spectator,
    });
  }
  return roster;
}

// ============================================================
// Publishing
// ============================================================

/**
 * Tell everyone in a room where they stand — and everyone who has just stopped being in it.
 *
 * The second half is the one that matters. A peer that has left, or whose room has been deleted
 * underneath it, is told an **empty roster**, and that is the only thing that ever closes a link:
 * a viewer stops watching because it is no longer offered anybody, not because it was asked to.
 */
function publishRoom(room: string): void {
  const { participants, pairs } = planFor(room);
  const present = new Set<WebSocket>();

  for (const self of participants) {
    present.add(self.ws);
    const peers = rosterFor(self, pairs);
    const signature = JSON.stringify(peers);
    const previous = published.get(self.ws);
    // The room is recorded even when nothing is sent, because it is how a departing connection is
    // later traced back to the people who could see it — and a lobby that has become a match must
    // not stay recorded as the place its peers live.
    published.set(self.ws, { room, signature });
    if (previous?.signature === signature) continue;
    send(self.ws, { type: 'media_peers', self: self.peerId, peers });
  }

  for (const ws of roomMembers.get(room) ?? []) {
    if (present.has(ws)) continue;
    const peerId = peerIds.get(ws);
    // Nothing to tell a socket that has stopped taking part altogether — it is already gone, and
    // this pass is only here to drop it from the room's membership.
    if (!peerId) continue;
    // **A peer that has moved somewhere else is not alone.** Starting a match moves everybody from a
    // lobby to a match — a different room holding the same people — and telling them here that they
    // have no peers would close every link a moment before the new room reopened it. Their new
    // room's publish is what describes them; this one has nothing true to say about them.
    //
    // Note this asks whether they went *elsewhere*, not merely whether they are somewhere. A board
    // camera whose owner has just stopped nominating it is still in this very room, and it is
    // precisely the peer that has to be told it is alone.
    const now = roomOf(getClient(ws));
    if (now && now !== room) continue;
    if (published.get(ws)?.signature === EMPTY_ROSTER) continue;
    published.set(ws, { room, signature: EMPTY_ROSTER });
    send(ws, { type: 'media_peers', self: peerId, peers: [] });
  }

  if (present.size > 0) roomMembers.set(room, present);
  else roomMembers.delete(room);
}

const EMPTY_ROSTER = '[]';

/**
 * Republish for whatever room this connection is in, and for one it may have just left.
 *
 * Called from the handful of places that move somebody — see `ROOM_CHANGING_TYPES` in wsHandler.ts.
 * Cheap to call needlessly, since an unchanged roster sends nothing.
 *
 * **The old room goes first.** A connection that moved from one to the other is absent from the old
 * room's plan and so is told it is alone; doing that after the new room had already been published
 * would clear the roster it had just been given.
 */
export function publishMediaFor(ws: WebSocket, previousRoom?: string | null): void {
  if (!MEDIA_ENABLED) return;
  const room = roomOf(getClient(ws));
  if (previousRoom && previousRoom !== room) publishRoom(previousRoom);
  if (room) publishRoom(room);
}

/** The room a connection is in right now, for a caller that is about to move it. */
export function mediaRoomOf(ws: WebSocket): string | null {
  if (!MEDIA_ENABLED) return null;
  return roomOf(getClient(ws));
}

/**
 * Republish for a room by name.
 *
 * For the paths that tear a room down: by the time anyone can be told, the clients have already been
 * moved off it, so the room has to be named rather than found through somebody who was in it.
 */
export function publishMediaForRoom(room: string): void {
  if (!MEDIA_ENABLED) return;
  publishRoom(room);
}

// ============================================================
// Handlers
// ============================================================

/**
 * How this deployment is tuned. Sent to every connection as it arrives, whatever kind it turns out
 * to be.
 *
 * The client's share of the settings, and only that: the `server` section stays here. What the file
 * does not answer is filled in on the way out — the ICE urls in the shape the DOM wants, whether the
 * internal STUN server is actually there to be used, and how many peers this server will offer at
 * once, which comes from its capacity model.
 *
 * The `internal` entry is passed on as it stands rather than resolved: it means "the STUN server at
 * the address you reached me on", and the client is the side that knows what address that was. It is
 * dropped entirely when nothing came up behind it, so a client is never pointed at a closed port.
 */
export function sendAppConfig(ws: WebSocket): void {
  send(ws, {
    type: 'app_config',
    frontend: CONFIG.frontend,
    scorer: CONFIG.scorer,
    media: {
      enabled: MEDIA_ENABLED,
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

/**
 * A connection volunteering, and saying how much it will send.
 *
 * Sent again whenever the tier changes, so this both joins and updates. The peer id it was given
 * survives a repeat — a phone switching from stills to video is the same peer, and minting it a new
 * identity would tear down the link somebody is watching.
 *
 * `disabled` is a way out rather than a way in: it means the same as never having volunteered.
 */
export function handleMediaReady(ws: WebSocket, msg: any): void {
  if (!MEDIA_ENABLED) return;
  const client = getClient(ws);
  if (!client) return;

  const tier = validateTier(msg.tier);
  if (tier === 'disabled') {
    releaseMediaState(ws);
    if (client.deviceId) noteDeviceTier(client.deviceId, 'disabled');
    return;
  }

  tiers.set(ws, tier);
  if (!peerIds.has(ws)) peerIds.set(ws, crypto.randomUUID());
  if (client.deviceId) noteDeviceTier(client.deviceId, tier);
  publishMediaFor(ws);
}

/** Only a value the protocol names. Anything else is a peer that does not get to take part. */
function validateTier(raw: unknown): MediaTier {
  return raw === 'video' || raw === 'stills' ? raw : 'disabled';
}

/** Keep the owner's device list in step, since that is where the board camera is chosen. */
function noteDeviceTier(deviceId: string, tier: MediaTier): void {
  setDeviceMediaTier(deviceId, tier);
  const owner = ownerOf(deviceId);
  if (owner) publishDevicesState(owner);
}

/**
 * A socket that has just become a scoring device, carrying over whatever it already said it would
 * share.
 *
 * A phone announces its tier as soon as it connects, which is *before* it has proven who it is —
 * so at that moment there is no device record to write it to. Called once the identity is
 * established, so the owner's list can offer a camera that has been willing all along rather than
 * one that looks like it declined.
 */
export function syncDeviceTier(ws: WebSocket): void {
  if (!MEDIA_ENABLED) return;
  const client = getClient(ws);
  const tier = tiers.get(ws);
  if (!client?.deviceId || !tier) return;
  noteDeviceTier(client.deviceId, tier);
}

export function handleMediaLeave(ws: WebSocket): void {
  const client = getClient(ws);
  if (client?.deviceId) noteDeviceTier(client.deviceId, 'disabled');
  releaseMediaState(ws);
}

/**
 * A frontend nominating one of its own devices as the board camera, or none.
 *
 * The ownership check is the point: a connection may only nominate a device it currently holds, so
 * naming somebody else's camera achieves nothing. Silence rather than an error, like every other
 * refusal here — the roster that comes back is the answer.
 */
export function handleSelectCamera(ws: WebSocket, msg: any): void {
  if (!MEDIA_ENABLED) return;
  const client = getClient(ws);
  if (!client || client.deviceId) return;

  if (msg.deviceId === null || msg.deviceId === undefined) {
    boardCameras.delete(client.sessionId);
  } else if (typeof msg.deviceId === 'string' && ownerOf(msg.deviceId) === client.sessionId) {
    boardCameras.set(client.sessionId, msg.deviceId);
  } else {
    return;
  }

  publishMediaFor(ws);
}

/**
 * One end of a negotiation, on its way to exactly one other peer.
 *
 * Everything here is a reason to drop the message in silence rather than to answer, for the same
 * reason the scoring-device handlers are silent: a peer that has lost its right to speak learns that
 * from its roster, which is the one authority on the question, and an error frame would only race it.
 *
 * The roster is recomputed here rather than remembered. That is what closes the window where a peer
 * left a match a moment ago and its last message is still in flight.
 */
export function handleMediaSignal(ws: WebSocket, msg: any): void {
  if (!MEDIA_ENABLED) return;
  const self = peerIds.get(ws);
  if (!self || typeof msg.to !== 'string') return;

  const description = validateSignal(msg.description);
  if (!description) return;

  const room = roomOf(getClient(ws));
  if (!room) return;

  const { participants, pairs } = planFor(room);
  const me = participants.find((p) => p.peerId === self);
  if (!me) return;

  // The pair has to exist in the plan. Not "the target is in this room" and not "the target is a
  // peer" — the exact pair, as the server itself made it.
  const paired = pairs.some(
    ({ a, b }) => (a.peerId === self && b.peerId === msg.to) || (b.peerId === self && a.peerId === msg.to),
  );
  if (!paired) return;

  const target = participants.find((p) => p.peerId === msg.to);
  if (!target) return;

  send(target.ws, { type: 'media_signal', from: self, description });
}

/** Re-exported so the router can size a description without importing the shared module twice. */
export { MAX_SDP_BYTES };
