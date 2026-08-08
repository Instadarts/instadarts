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
import { sanitizeName, validateDeviceClaims, validateTips } from './validation';
import { getScoringSession, dropScoringSessions } from './scoring/store';
import { SUMMARY_TTL_MS, touch } from './lifecycle';
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

/** Tell a scoring device where it stands. A retained topic: pushed on connect and on every change. */
function publishScorerState(deviceId: string): void {
  const ws = deviceSockets.get(deviceId);
  if (!ws) return;
  const owner = ownerOf(deviceId);
  send(ws, {
    type: 'scorer_state',
    status: owner ? 'active' : 'waiting',
    cameras: owner ? activeCameras(owner).length : 0,
  });
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
  for (const deviceId of scoringDevicesFor(match.id)) publishScorerState(deviceId);
}

/** Every scoring device whose owner is playing in this match. */
function scoringDevicesFor(matchId: string): string[] {
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

export function handleScorerPair(ws: WebSocket, msg: any): void {
  const client = getClient(ws);
  if (!client || client.deviceId) return;

  const paired = redeemPairingCode(msg.code, client.sessionId);
  if (!paired) {
    send(ws, { type: 'scorer_refused', reason: 'bad_code' });
    return;
  }

  bindDeviceSocket(ws, client, paired.deviceId);
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

  bindDeviceSocket(ws, client, device.id);
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

  setCameraActive(client.deviceId, Boolean(msg.active));
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
function bindDeviceSocket(ws: WebSocket, client: Client, deviceId: string): void {
  const existing = deviceSockets.get(deviceId);
  if (existing && existing !== ws) {
    const stale = getClient(existing);
    if (stale) stale.deviceId = null;
    send(existing, { type: 'scorer_refused', reason: 'unpaired' });
  }
  client.deviceId = deviceId;
  deviceSockets.set(deviceId, ws);
  publishScorerState(deviceId);
}
