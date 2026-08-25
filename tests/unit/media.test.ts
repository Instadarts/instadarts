// Server-side media coordination. WebRTC itself is covered in the browser suites; this file proves
// match lifetime, desired topology, source epochs, and signaling authorization.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import '../helpers';
// The helpers register x01. Whac-A-Mole is installed the way a deployment installs it, because it
// is the mode that declines board video and the only way to exercise a ban is to have one.
import '../../src/server/modes/whac-a-mole';
// And count-up, because it is the only installed mode that takes more than two players — which is
// what a test about boards versus players needs.
import '../../src/server/modes/count-up';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { finishMediaForMatch } from '../../src/server/media';
import { resetDeviceRegistry } from '../../src/server/devices';
import { checkRateLimit, releaseRateLimit } from '../../src/server/rateLimit';
import { deleteLobby, deleteMatch, getAllLobbies, getAllMatches, getMatch } from '../../src/server/store';
import { sweepLifecycle } from '../../src/server/lifecycle';
import type { ServerMessage } from '../../src/shared/protocol';
import type { MediaPeer, MediaTier } from '../../src/shared/media';

let sessionCounter = 0;
const openSockets: WebSocket[] = [];

function connect() {
  const sessionId = `media-session-${++sessionCounter}`;
  const received: (ServerMessage | { type: 'connected'; sessionId: string })[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;
  registerClient(ws, {
    sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null,
  });
  openSockets.push(ws);

  return {
    ws, sessionId, received,
    send(message: object) {
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(message));
    },
    last<T extends ServerMessage['type']>(type: T) {
      return received.filter((message) => message.type === type).at(-1) as
        Extract<ServerMessage, { type: T }> | undefined;
    },
    count(type: ServerMessage['type']) {
      return received.filter((message) => message.type === type).length;
    },
    peerId() { return this.last('media_peers')?.self; },
    roster(): MediaPeer[] { return this.last('media_peers')?.peers ?? []; },
    playerId() {
      for (let index = received.length - 1; index >= 0; index--) {
        const message = received[index];
        if ((message.type === 'lobby_state' || message.type === 'match_state') && message.yourPlayerIds?.[0]) {
          return message.yourPlayerIds[0];
        }
      }
      return undefined;
    },
    resumeToken() { return this.last('resume')?.token; },
  };
}

type Connection = ReturnType<typeof connect>;

function pairDevice(frontend: Connection, name = 'Board', tier: MediaTier = 'video') {
  frontend.send({ type: 'create_pairing_code' });
  const scorer = connect();
  scorer.send({ type: 'scorer_pair', code: frontend.last('pairing_code')!.code });
  const paired = scorer.last('scorer_paired')!;
  const claim = frontend.last('device_paired')!;
  frontend.send({
    type: 'activate_devices',
    devices: [{ deviceId: claim.deviceId, tokenHash: claim.tokenHash, grabbedAt: 1 }],
  });
  scorer.send({ type: 'scorer_name', name });
  scorer.send({ type: 'media_ready', tier });
  return Object.assign(scorer, {
    deviceId: paired.deviceId,
    deviceToken: paired.token,
    tokenHash: claim.tokenHash,
  });
}

function onlineLobby() {
  const host = connect();
  host.send({ type: 'create_lobby', acceptsJoins: true });
  const lobbyId = host.last('lobby_state')!.lobby.id;
  host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
  const guest = connect();
  guest.send({ type: 'join_lobby', inviteCode: host.last('lobby_state')!.lobby.inviteCode! });
  guest.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
  return { host, guest, lobbyId };
}

/**
 * An online count-up match, one connection per user, each adding the names listed for it. The mode
 * matters: x01 caps itself at two players, and every shape worth testing here has more.
 */
function startBoards(names: string[][]) {
  const host = connect();
  host.send({ type: 'create_lobby', acceptsJoins: true });
  const lobbyId = host.last('lobby_state')!.lobby.id;
  host.send({ type: 'update_settings', lobbyId, settings: { mode: 'count-up' } });
  const inviteCode = host.last('lobby_state')!.lobby.inviteCode!;
  const users = [host];
  for (const [index, mine] of names.entries()) {
    const user = index === 0 ? host : connect();
    if (index > 0) { user.send({ type: 'join_lobby', inviteCode }); users.push(user); }
    for (const name of mine) user.send({ type: 'add_local_player', lobbyId, playerName: name });
  }
  host.send({ type: 'start_match', lobbyId });
  const match = host.last('match_started')!.match;
  for (const user of users) {
    user.send({ type: 'media_join', matchId: match.id, tier: 'video', boardCamera: null });
  }
  return { users, host, match };
}

function startOnline(options: {
  camera?: boolean;
  hostTier?: MediaTier;
  guestTier?: MediaTier;
  settings?: object;
} = {}) {
  const { host, guest, lobbyId } = onlineLobby();
  const camera = options.camera === false ? null : pairDevice(host, 'Alice board');
  if (options.settings) host.send({ type: 'update_settings', lobbyId, settings: options.settings });
  host.send({ type: 'start_match', lobbyId });
  const match = host.last('match_started')!.match;
  host.send({
    type: 'media_join', matchId: match.id, tier: options.hostTier ?? 'video',
    boardCamera: camera?.deviceId ?? null,
  });
  guest.send({
    type: 'media_join', matchId: match.id, tier: options.guestTier ?? 'video', boardCamera: null,
  });
  return { host, guest, camera, match };
}

const entryFor = (self: Connection, other: Connection) =>
  self.roster().find((peer) => peer.peerId === other.peerId());

beforeEach(() => resetDeviceRegistry());

afterEach(() => {
  for (const ws of openSockets.splice(0)) removeClient(ws);
  for (const id of [...getAllMatches().keys()]) { finishMediaForMatch(id); deleteMatch(id); }
  for (const id of [...getAllLobbies().keys()]) deleteLobby(id);
  resetDeviceRegistry();
});

describe('match-scoped lifetime and setup', () => {
  it('creates no peer identity, roster, or signaling permission in a lobby', () => {
    const { host, guest } = onlineLobby();
    const camera = pairDevice(host);
    host.send({ type: 'media_ready', tier: 'video' });
    guest.send({ type: 'media_ready', tier: 'video' });

    expect(host.count('media_peers')).toBe(0);
    expect(guest.count('media_peers')).toBe(0);
    expect(camera.count('media_peers')).toBe(0);
    host.send({ type: 'media_signal', to: 'forged', description: { type: 'offer', sdp: 'v=0\r\n' } });
    expect(camera.count('media_signal')).toBe(0);
  });

  it('gives one slot per board, so a user holding two players still declares once', () => {
    // Two users, three players: the host holds Alice and Carol at one board, the guest holds Bob at
    // another. Slots are boards and not players — keyed per player, the third slot would wait for a
    // declaration nothing can send and setup would never complete.
    const { users, host, match } = startBoards([['Alice', 'Carol'], ['Bob']]);
    const [, guest] = users;

    expect(match.players).toHaveLength(3);
    expect(host.last('media_peers')!.setupComplete).toBe(true);
    expect(guest.last('media_peers')!.setupComplete).toBe(true);
    expect(entryFor(host, guest)).toBeDefined();
    expect(host.last('match_started')!.mediaDisabled).toBe(false);

    // Alice and Carol answer to the host's board; Bob is his own.
    const [alice, carol, bob] = match.players;
    expect(carol.boardId).toBe(alice.id);
    expect(alice.boardId).toBe(alice.id);
    expect(bob.boardId).toBe(bob.id);
  });

  it('creates no session at all once a third board is in play', () => {
    const { users, host, match } = startBoards([['Alice'], ['Bob'], ['Carol']]);

    expect(match.players).toHaveLength(3);
    // Not a roster with nobody in it — no peer identity was ever minted, which is the same state a
    // deployment with media switched off produces.
    for (const user of users) expect(user.count('media_peers')).toBe(0);
    // And the screen is told why, or missing video reads as a fault.
    expect(host.last('match_started')!.mediaDisabled).toBe(true);
  });

  it('waits for every participant declaration, with disabled counting and spectators excluded', () => {
    const { host, guest, match } = startOnline({ camera: false, guestTier: 'disabled' });
    expect(host.last('media_peers')!.setupComplete).toBe(true);
    expect(guest.count('media_peers')).toBe(0);

    const watcher = connect();
    watcher.send({ type: 'spectate', id: match.id });
    watcher.send({ type: 'media_join', matchId: match.id, tier: 'video', boardCamera: 'forged' });
    expect(watcher.last('media_peers')!.setupComplete).toBe(true);
  });

  it('makes invalid or unowned camera nominations null without blocking setup', () => {
    const { host, guest, camera, match } = startOnline();
    guest.send({ type: 'media_join', matchId: match.id, tier: 'video', boardCamera: camera!.deviceId });
    expect(entryFor(guest, camera!)).toBeDefined(); // host selection remains the source
    expect(camera!.last('media_source_state')).toMatchObject({ active: true, matchId: match.id });
    expect(guest.last('media_peers')!.setupComplete).toBe(true);
  });

  it('destroys the session and publishes empty rosters on match finish', () => {
    const { host, guest, camera, match } = startOnline();
    const meshId = host.last('media_peers')!.meshId;
    guest.send({ type: 'leave_match', matchId: match.id });

    expect(host.last('media_peers')).toMatchObject({ meshId, peers: [] });
    expect(camera!.last('media_source_state')).toMatchObject({ active: false, meshId });
  });

  it('tears media down when gameplay reaches victory', () => {
    const { host, camera, match } = startOnline({
      settings: { mode: 'x01', modeSettings: { startScore: 180, doubleIn: false, doubleOut: false } },
    });
    const dart = { x: 500_000, y: 726_000 };
    host.send({ type: 'add_dart', matchId: match.id, dart });
    host.send({ type: 'add_dart', matchId: match.id, dart });
    host.send({ type: 'add_dart', matchId: match.id, dart });
    host.send({ type: 'submit_visit', matchId: match.id });

    expect(host.last('match_state')!.match.status).toBe('finished');
    expect(camera!.last('media_source_state')).toMatchObject({ active: false, matchId: match.id });
    expect(host.last('media_peers')!.peers).toEqual([]);
  });

  it('tears media down when an in-progress match expires idle', () => {
    const { host, camera, match } = startOnline();
    sweepLifecycle(match.expiresAt + 1);

    expect(host.last('match_finished')!.match.status).toBe('finished');
    expect(camera!.last('media_source_state')).toMatchObject({ active: false, matchId: match.id });
    expect(host.last('media_peers')!.peers).toEqual([]);
  });

  it('tears media down when a local owner cancels the match', () => {
    const user = connect();
    user.send({ type: 'create_lobby', acceptsJoins: false });
    const lobbyId = user.last('lobby_state')!.lobby.id;
    user.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    const camera = pairDevice(user, 'Local board');
    user.send({ type: 'start_match', lobbyId });
    const matchId = user.last('match_started')!.match.id;
    user.send({ type: 'media_join', matchId, tier: 'video', boardCamera: camera.deviceId });
    user.send({ type: 'leave_match', matchId });

    expect(camera.last('media_source_state')).toMatchObject({ active: false, matchId });
    expect(user.last('media_peers')!.peers).toEqual([]);
  });
});

describe('topology and source intent', () => {
  it('builds the online topology from stable player slots', () => {
    const { host, guest, camera } = startOnline();
    expect(entryFor(host, guest)).toBeDefined();
    expect(entryFor(host, camera!)).toMatchObject({ kind: 'device', own: true, role: 'owner' });
    expect(entryFor(guest, camera!)).toMatchObject({ kind: 'device', own: false, role: 'opponent' });
    expect(entryFor(camera!, host)).toMatchObject({ own: true, role: 'owner' });
    expect(entryFor(camera!, guest)).toMatchObject({ own: false, role: 'opponent' });
    // Device names belong to the owner's camera panel. The roster carries only the stable player
    // association needed for remote presentation, never that private label.
    expect(entryFor(host, camera!)).not.toHaveProperty('label');
    expect(entryFor(guest, camera!)).not.toHaveProperty('label');
  });

  it('offers a local shared source to spectators without making it self-video', () => {
    const user = connect();
    user.send({ type: 'create_lobby', acceptsJoins: false });
    const lobbyId = user.last('lobby_state')!.lobby.id;
    user.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    user.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
    const camera = pairDevice(user);
    user.send({ type: 'start_match', lobbyId });
    const matchId = user.last('match_started')!.match.id;
    user.send({ type: 'media_join', matchId, tier: 'video', boardCamera: camera.deviceId });
    const watcher = connect();
    watcher.send({ type: 'spectate', id: matchId });
    watcher.send({ type: 'media_join', matchId, tier: 'video', boardCamera: null });

    expect(entryFor(user, camera)).toMatchObject({ own: true }); // control/stills edge
    expect(entryFor(watcher, camera)).toBeDefined();
    expect(camera.last('media_source_state')).toMatchObject({ active: true, audience: ['spectator'] });
    // One board, so one slot — and one declaration completes setup however many players stand at it.
    // Slots keyed per player instead would wait here for a declaration nothing can send.
    expect(user.last('media_peers')!.setupComplete).toBe(true);
  });

  it('never asks a camera to publish for a game mode that declined board video', () => {
    const { host, camera, match } = startOnline({ settings: { mode: 'whac-a-mole' } });
    expect(match.settings.mode).toBe('whac-a-mole');

    // No active directive, so the phone mints no feed id and offers nothing. Compare the same call
    // without settings, which is x01 and is asserted active above.
    const directive = camera!.last('media_source_state');
    expect(directive === undefined || directive.active === false).toBe(true);

    // The camera keeps its place in every roster. That is the whole reason this is refused at the
    // source directive rather than by leaving the device out of the plan: stills, director commands
    // and the owner's own link are a different feature and this mode still wants them.
    expect(entryFor(host, camera!)).toMatchObject({ kind: 'device', own: true, role: 'owner' });
    expect(host.last('media_peers')!.setupComplete).toBe(true);
  });

  it('asks the same camera to publish once the mode is one that wants it', () => {
    // The control for the case above: nothing about the pairing or the nomination differs.
    const { camera } = startOnline({ settings: { mode: 'x01' } });
    expect(camera!.last('media_source_state')).toMatchObject({ active: true });
  });

  it('ends and replaces source epochs on source change or scorer incarnation', () => {
    const { host, camera, match } = startOnline();
    const first = camera!.last('media_source_state');
    expect(first?.active).toBe(true);

    const replacement = connect();
    replacement.send({ type: 'media_ready', tier: 'video' });
    replacement.send({ type: 'scorer_hello', deviceId: camera!.deviceId, token: camera!.deviceToken });
    const second = replacement.last('media_source_state');
    expect(second?.active).toBe(true);
    if (first?.active && second?.active) expect(second.sourceEpoch).not.toBe(first.sourceEpoch);

    host.send({ type: 'media_join', matchId: match.id, tier: 'disabled', boardCamera: null });
    expect(replacement.last('media_source_state')).toMatchObject({ active: false });
  });

  it('replaces the source epoch for a new nomination and for tier reactivation', () => {
    const { host, camera, match } = startOnline();
    const first = camera!.last('media_source_state');
    expect(first?.active).toBe(true);

    const secondCamera = pairDevice(host, 'Replacement board');
    host.send({ type: 'media_join', matchId: match.id, tier: 'video', boardCamera: secondCamera.deviceId });
    expect(camera!.last('media_source_state')).toMatchObject({ active: false });
    const second = secondCamera.last('media_source_state');
    expect(second?.active).toBe(true);
    if (first?.active && second?.active) expect(second.sourceEpoch).not.toBe(first.sourceEpoch);

    secondCamera.send({ type: 'media_ready', tier: 'disabled' });
    expect(secondCamera.last('media_source_state')).toMatchObject({ active: false });
    secondCamera.send({ type: 'media_ready', tier: 'video' });
    const reactivated = secondCamera.last('media_source_state');
    expect(reactivated?.active).toBe(true);
    if (second?.active && reactivated?.active) expect(reactivated.sourceEpoch).not.toBe(second.sourceEpoch);
  });

  it('keeps the source epoch when only the participant frontend is replaced', () => {
    const { host, camera, match } = startOnline();
    const active = camera!.last('media_source_state');
    const oldPeer = host.peerId();
    const replacement = connect();
    replacement.send({ type: 'reconnect', matchId: match.id, token: host.resumeToken() });
    // The media declaration is allowed to beat transient device-claim restoration. This exact
    // camera was already validated for the immutable player slot, so that ordering must not turn a
    // page reload into an explicit source withdrawal.
    replacement.send({ type: 'media_join', matchId: match.id, tier: 'video', boardCamera: camera!.deviceId });
    replacement.send({
      type: 'activate_devices',
      devices: [{ deviceId: camera!.deviceId, tokenHash: camera!.tokenHash, grabbedAt: 2 }],
    });

    expect(replacement.peerId()).not.toBe(oldPeer);
    const repeated = camera!.last('media_source_state');
    if (active?.active && repeated?.active) expect(repeated.sourceEpoch).toBe(active.sourceEpoch);
  });
});

describe('match boundaries and signaling', () => {
  it('tears down and rebuilds every identity for a rematch', () => {
    const { host, guest, lobbyId } = onlineLobby();
    const camera = pairDevice(host);
    host.send({
      type: 'update_settings', lobbyId,
      settings: { mode: 'x01', modeSettings: { startScore: 60, doubleIn: false, doubleOut: false } },
    });
    host.send({ type: 'start_match', lobbyId });
    const original = host.last('match_started')!.match;
    host.send({ type: 'media_join', matchId: original.id, tier: 'video', boardCamera: camera.deviceId });
    guest.send({ type: 'media_join', matchId: original.id, tier: 'video', boardCamera: null });
    const oldMesh = host.last('media_peers')!.meshId;
    const oldPeer = host.peerId();

    const finished = getMatch(original.id)!;
    finished.status = 'finished';
    finished.finishedAt = Date.now();
    finishMediaForMatch(original.id);
    host.send({ type: 'rematch_vote', matchId: original.id, playerId: host.playerId(), answer: 'accepted' });
    guest.send({ type: 'rematch_vote', matchId: original.id, playerId: guest.playerId(), answer: 'accepted' });
    const rematch = host.last('match_started')!.match;

    host.send({ type: 'media_join', matchId: rematch.id, tier: 'video', boardCamera: camera.deviceId });
    guest.send({ type: 'media_join', matchId: rematch.id, tier: 'video', boardCamera: null });
    expect(host.last('media_peers')!.meshId).not.toBe(oldMesh);
    expect(host.peerId()).not.toBe(oldPeer);
  });

  it('relays only between the exact pair in the current match roster', () => {
    const { host, guest, camera } = startOnline();
    const offer = { type: 'offer' as const, sdp: 'v=0\r\n' };
    host.send({ type: 'media_signal', to: camera!.peerId(), description: offer });
    expect(camera!.last('media_signal')).toEqual({
      type: 'media_signal', from: host.peerId(), description: offer,
    });

    const other = startOnline({ camera: false });
    host.send({ type: 'media_signal', to: other.host.peerId(), description: offer });
    expect(other.host.count('media_signal')).toBe(0);
    expect(guest.count('error')).toBe(0);
  });
});

describe('the media plane does not spend a player\'s budget', () => {
  it('answers media_join and media_ready from its own, so they cannot cost a dart', () => {
    const user = connect();

    // `handleMessage` directly rather than the harness's `send`, which resets both budgets before
    // every message: the whole question here is what one budget does to the other.
    for (let i = 0; i < 40; i += 1) {
      handleMessage(user.ws, JSON.stringify({
        type: 'media_join', matchId: 'no-such-match', tier: 'video', boardCamera: null,
      }));
      handleMessage(user.ws, JSON.stringify({ type: 'media_ready', tier: 'video' }));
    }

    // Eighty media messages, and the general budget has not been touched: the dart still gets
    // through. Sharing one bucket, the eleventh of those would have taken it.
    expect(checkRateLimit(user.sessionId)).toBe(true);
    releaseRateLimit(user.sessionId, null);
  });
});
