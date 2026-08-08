// The scoring-device half of the socket layer.
//
// A scoring device is a phone pointed at the board. It pairs with a frontend, publishes what its
// camera saw, and is told where it stands — and none of that touches a lobby, a visit or a game
// mode. It lives apart from the gameplay handlers because the two share only a socket registry:
// what they have in common is in connections.ts, and everything below is about devices.
//
// The one place the two meet is `commitScoredMatch`, which is how a match moves whether the darts
// were clicked or seen.

import type { WebSocket } from 'ws';
import type { MatchState } from '../shared/types';
import type { Client } from './types';
import { getMatch, updateMatch } from './store';
import { sanitizeCameraError, sanitizeName, validateDeviceClaims, validateTips } from './validation';
import { getScoringSession, dropScoringSessions } from './scoring/store';
import { SUMMARY_TTL_MS, touch } from './lifecycle';
import { canAcceptDevice } from './capacity';
import {
  allClients,
  broadcastToMatch,
  findSessionSocket,
  getClient,
  matchMessage,
  send,
} from './connections';
import {
  claimDevice,
  createPairingCode,
  devicesForSession,
  ownerOf,
  redeemPairingCode,
  releaseDevice,
  releaseSession,
  setCameraActive,
  setDeviceName,
  unclaimDevice,
  verifyDevice,
} from './devices';

/** Whichever side of the pairing this connection was, let go of it. */
export function releaseScoringState(client: Client): void {
  if (client.deviceId) {
    const owner = ownerOf(client.deviceId);
    deviceSockets.delete(client.deviceId);
    releaseDevice(client.deviceId);
    if (owner) publishDevicesState(owner);
    return;
  }
  for (const deviceId of releaseSession(client.sessionId)) {
    publishScorerState(deviceId);
  }
}

/** Live scoring-device sockets, by device id. The registry in devices.ts holds no sockets. */
const deviceSockets = new Map<string, WebSocket>();

/** Tell a frontend how its devices are doing. */
function publishDevicesState(sessionId: string): void {
  const ws = findSessionSocket(sessionId);
  if (!ws) return;
  send(ws, { type: 'devices_state', devices: devicesForSession(sessionId) });
}

/**
 * Tell a scoring device where it stands. A retained topic: pushed on connect and on every change.
 *
 * `scoring` is the one the device acts on. It comes from `resolveScoringTarget` — the same call
 * that decides whether tips are accepted — so a device powering its camera down because it is not
 * scoring can never be a device whose tips would have been taken.
 */
function publishScorerState(deviceId: string): void {
  const ws = deviceSockets.get(deviceId);
  if (!ws) return;
  const owner = ownerOf(deviceId);
  send(ws, {
    type: 'scorer_state',
    status: owner ? 'active' : 'waiting',
    scoring: owner ? resolveScoringTarget(owner) !== null : false,
    cameras: owner ? activeCameras(owner).length : 0,
  });
}

/** Push to a set of devices captured earlier — see `devicesScoringInto`. */
export function publishScorerStateFor(deviceIds: readonly string[]): void {
  for (const deviceId of deviceIds) publishScorerState(deviceId);
}

/** The devices this frontend has active with a running camera. */
function activeCameras(ownerSessionId: string): string[] {
  return devicesForSession(ownerSessionId)
    .filter((d) => d.online && d.cameraActive)
    .map((d) => d.deviceId);
}

/**
 * Which match a frontend's cameras score into, and for whom.
 *
 * The owner must be an actual player in a running match. Spectators get a `matchId` too, which is
 * exactly why the check is here: a spectator with a paired camera must not become a scorer.
 */
function resolveScoringTarget(ownerSessionId: string): { match: MatchState; ownerPlayerId: string | null } | null {
  for (const [, client] of allClients()) {
    if (client.deviceId || client.sessionId !== ownerSessionId) continue;
    if (client.isSpectator || !client.matchId) return null;
    const match = getMatch(client.matchId);
    if (!match || match.status !== 'in_progress') return null;
    // A local match is one board scored for whoever is up; an online one scores only for its owner.
    return { match, ownerPlayerId: match.isLocal ? null : client.playerId };
  }
  return null;
}

/**
 * One inference's dart tips from a scoring device.
 *
 * Everything here is a reason to drop the report silently rather than to answer: a scoring device
 * that has lost its right to speak should learn that from `scorer_state`, not from an error frame
 * arriving once per frame.
 */
export function handleScorerTips(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
  if (!client?.deviceId) return;

  // A malformed report is dropped whole. It is never salvaged into an empty array, because an
  // empty array means the darts came out.
  const tips = validateTips(msg.tips);
  if (!tips) return;

  const owner = ownerOf(client.deviceId);
  if (!owner) return;
  const target = resolveScoringTarget(owner);
  if (!target) return;

  const session = getScoringSession(target.match.id, target.ownerPlayerId, commitScoredMatch);
  session.setCameras(activeCameras(owner));
  session.addTips(client.deviceId, tips);
}

/**
 * The match changed: persist it, tell everyone in it, and refresh the scoring devices watching it.
 * Used by manual darts and camera darts alike — there is only one way a match moves.
 */
export function commitScoredMatch(match: MatchState): void {
  // A dart is input, so it pushes the idle deadline back; a match the mode has just decided swaps
  // that deadline for its summary clock.
  if (match.status === 'in_progress') {
    touch(match);
  } else {
    touch(match, SUMMARY_TTL_MS);
    dropScoringSessions(match.id);
  }
  updateMatch(match.id, match);
  broadcastToMatch(match.id, matchMessage('match_state', match));
  publishScorerStateFor(devicesScoringInto(match.id));
}

/**
 * Every scoring device whose owner is playing in this match.
 *
 * Exported because a match ending clears `client.matchId` before anyone can be told, so the callers
 * that tear a match down have to capture the list first and push afterwards.
 */
export function devicesScoringInto(matchId: string): string[] {
  const found: string[] = [];
  for (const [, client] of allClients()) {
    if (client.deviceId || client.matchId !== matchId || client.isSpectator) continue;
    for (const device of devicesForSession(client.sessionId)) {
      if (device.online) found.push(device.deviceId);
    }
  }
  return found;
}

export function handleCreatePairingCode(ws: WebSocket): void {
  const client = getClient(ws);
  if (!client) return;
  const { code, expiresAt } = createPairingCode(client.sessionId);
  send(ws, { type: 'pairing_code', code, expiresAt });
}

/**
 * A frontend taking devices for this session — sent on every connect for whatever this tab has
 * active, which is what re-establishes a pairing after a server restart.
 */
export function handleActivateDevices(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
  if (!client) return;

  for (const claim of validateDeviceClaims(msg.devices)) {
    const previousOwner = ownerOf(claim.deviceId);
    const result = claimDevice(claim.deviceId, claim.tokenHash, client.sessionId, claim.grabbedAt);
    if (result === 'stale') {
      // Another tab of this browser holds it with a newer grab. Say so, so this one stops asking.
      send(ws, { type: 'device_lost', deviceId: claim.deviceId });
      continue;
    }
    if (result === 'mismatch') continue;
    if (previousOwner && previousOwner !== client.sessionId) {
      const loser = findSessionSocket(previousOwner);
      if (loser) send(loser, { type: 'device_lost', deviceId: claim.deviceId });
      publishDevicesState(previousOwner);
    }
    publishScorerState(claim.deviceId);
  }

  publishDevicesState(client.sessionId);
}

export function handleDeactivateDevice(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
  if (!client || typeof msg.deviceId !== 'string') return;
  if (!unclaimDevice(msg.deviceId, client.sessionId)) return;
  publishScorerState(msg.deviceId);
  publishDevicesState(client.sessionId);
}

/**
 * A frontend asking one of its devices to start or stop its camera.
 *
 * Nothing is recorded here and nothing is answered. The device reports what actually happened
 * through `scorer_camera`, and that report — not this request — is what the owner's screen shows.
 * Sending an optimistic `devices_state` would put a camera "on" that may never have opened.
 */
export function handleSetDeviceCamera(ws: WebSocket, msg: any): void {
  const device = commandableDevice(ws, msg.deviceId);
  if (!device) return;
  send(device, { type: 'scorer_command', command: msg.active ? 'camera_on' : 'camera_off' });
}

/** A frontend sending one of its devices to standby. One-way: nothing here can bring it back. */
export function handlePowerOffDevice(ws: WebSocket, msg: any): void {
  const device = commandableDevice(ws, msg.deviceId);
  if (!device) return;
  send(device, { type: 'scorer_command', command: 'power_off' });
}

/**
 * The socket of a device this connection is allowed to command, if there is one.
 *
 * The claim is the authority: a device answers to whoever currently holds it and to nobody else, so
 * a stale tab or another user naming a device id gets silence rather than a camera. Silence rather
 * than an error for the same reason the other device handlers are silent — the owner learns what
 * its devices are doing from `devices_state`, which is where a command that did nothing shows up as
 * nothing changing.
 */
function commandableDevice(ws: WebSocket, deviceId: unknown): WebSocket | null {
  const client = getClient(ws);
  if (!client || client.deviceId || typeof deviceId !== 'string') return null;
  if (ownerOf(deviceId) !== client.sessionId) return null;
  return deviceSockets.get(deviceId) ?? null;
}

export function handleScorerPair(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
  if (!client || client.deviceId) return;

  const paired = redeemPairingCode(msg.code, client.sessionId);
  if (!paired) {
    send(ws, { type: 'scorer_refused', reason: 'bad_code' });
    return;
  }

  // Refused for room means the code is spent and the device has no identity to keep — nothing is
  // sent to the frontend either, so nobody is told a pairing exists that does not.
  if (!bindDeviceSocket(ws, client, paired.deviceId)) return;
  send(ws, { type: 'scorer_paired', deviceId: paired.deviceId, token: paired.token });

  // The frontend that showed the code has to persist the hash: the server will not remember it,
  // and it is what proves the pairing again after a restart.
  const owner = findSessionSocket(paired.ownerSessionId);
  if (owner) send(owner, { type: 'device_paired', deviceId: paired.deviceId, tokenHash: paired.tokenHash });
}

export function handleScorerHello(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
  if (!client || client.deviceId) return;

  const device = verifyDevice(msg.deviceId, msg.token, sanitizeName(msg.name) ?? '');
  if (!device) {
    send(ws, { type: 'scorer_refused', reason: 'unpaired' });
    return;
  }

  if (!bindDeviceSocket(ws, client, device.id)) return;
  const owner = ownerOf(device.id);
  if (owner) publishDevicesState(owner);
}

/**
 * A device giving up its pairing.
 *
 * The socket lives on and is unbound, which is the whole point: a connection may only pair while it
 * is nobody's device, so without this the phone would forget its token and then be unable to redeem
 * a new code without a reload. What the frontend holds is left alone — see ScorerUnpairMessage.
 */
export function handleScorerUnpair(ws: WebSocket): void {
  const client = getClient(ws);
  if (!client?.deviceId) return;

  const owner = ownerOf(client.deviceId);
  deviceSockets.delete(client.deviceId);
  releaseDevice(client.deviceId);
  client.deviceId = null;

  if (!owner) return;
  // A camera that has just left must leave the roster at once, or every throw window afterwards
  // waits for a report that is never coming — the same reason handleScorerCamera does this.
  const target = resolveScoringTarget(owner);
  if (target) {
    getScoringSession(target.match.id, target.ownerPlayerId, commitScoredMatch).setCameras(activeCameras(owner));
  }
  publishDevicesState(owner);
}

/** A device renaming itself. It owns its own name; a frontend only displays what it is told. */
export function handleScorerName(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
  if (!client?.deviceId) return;

  setDeviceName(client.deviceId, sanitizeName(msg.name) ?? '');
  const owner = ownerOf(client.deviceId);
  if (owner) publishDevicesState(owner);
}

export function handleScorerCamera(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
  if (!client?.deviceId) return;

  setCameraActive(client.deviceId, Boolean(msg.active), sanitizeCameraError(msg.error) ?? undefined);
  const owner = ownerOf(client.deviceId);
  if (owner) {
    // A camera leaving must leave the roster at once, or every throw window afterwards waits for a
    // report that is never coming.
    const target = resolveScoringTarget(owner);
    if (target) {
      getScoringSession(target.match.id, target.ownerPlayerId, commitScoredMatch).setCameras(activeCameras(owner));
    }
    publishDevicesState(owner);
  }
  publishScorerState(client.deviceId);
}

/** One socket per device: a second connection for the same id displaces the first. */
/**
 * Whether there is room for another scoring device.
 *
 * Counted from the live sockets rather than from the registry, because it is the connection that
 * costs something. Asked here because binding is the first moment a connection is known to be a
 * device at all — at the handshake it is just a socket.
 */
function deviceConnectionCount(): number {
  return deviceSockets.size;
}

function bindDeviceSocket(ws: WebSocket, client: Client, deviceId: string): boolean {
  const existing = deviceSockets.get(deviceId);
  // A device already holding a slot is reconnecting into it, not asking for another.
  if (!existing && !canAcceptDevice(deviceConnectionCount())) {
    send(ws, { type: 'scorer_refused', reason: 'server_full' });
    return false;
  }
  if (existing && existing !== ws) {
    const stale = getClient(existing);
    if (stale) stale.deviceId = null;
    send(existing, { type: 'scorer_refused', reason: 'unpaired' });
  }
  client.deviceId = deviceId;
  deviceSockets.set(deviceId, ws);
  publishScorerState(deviceId);
  return true;
}
