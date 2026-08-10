// What the server will and will not let two devices do to each other.
//
// The whole security model of the media feature is one sentence — *the roster is the authorization*
// — so these tests are about rosters and about what the relay does with a signal, and about nothing
// else. There is no WebRTC here: whether a peer connection can actually be made is a question for
// the browser, and tests/e2e/media-link.spec.ts asks it.
//
// The harness drives `handleMessage` exactly as the real server does, the same way devices.test.ts
// does — which is deliberate, because the routing guard that keeps a scoring device out of the
// gameplay handlers is part of what is under test here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
// Importing the helpers is what registers x01, and a lobby cannot be created without a mode.
import '../helpers';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { resetDeviceRegistry } from '../../src/server/devices';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { MEDIA_VIEWERS_PER_ROOM } from '../../src/server/capacity';
import type { ServerMessage } from '../../src/shared/protocol';
import type { MediaPeer, MediaTier } from '../../src/shared/media';

// ============================================================
// Harness
// ============================================================

let sessionCounter = 0;
const openSockets: WebSocket[] = [];

function connect() {
  const sessionId = `s${++sessionCounter}`;
  const received: ServerMessage[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => received.push(JSON.parse(raw)),
  } as unknown as WebSocket;

  registerClient(ws, {
    sessionId, lobbyId: null, matchId: null, playerId: null, isSpectator: false, deviceId: null,
  });
  openSockets.push(ws);

  return {
    ws,
    sessionId,
    received,
    send(msg: object) {
      // These tests are about authorization, and ten messages a second is not the property in hand.
      releaseRateLimit(sessionId, null);
      handleMessage(ws, JSON.stringify(msg));
    },
    last<T extends ServerMessage['type']>(type: T) {
      const hits = received.filter((m) => m.type === type);
      return hits[hits.length - 1] as Extract<ServerMessage, { type: T }> | undefined;
    },
    count(type: ServerMessage['type']) {
      return received.filter((m) => m.type === type).length;
    },
    /** This connection's own peer id, as the server told it. */
    peerId() {
      return this.last('media_peers')?.self;
    },
    /**
     * This connection's own player.
     *
     * Asked of the messages addressed to it, because a player on the wire no longer says whose it
     * is: `yourPlayerId` goes to one connection, the broadcast that follows it to everybody.
     */
    playerId() {
      for (let i = received.length - 1; i >= 0; i--) {
        const msg = received[i];
        if ((msg.type === 'lobby_state' || msg.type === 'match_state') && msg.yourPlayerId) return msg.yourPlayerId;
      }
      return undefined;
    },
    /** The roster as it stands, or an empty one for a peer that has never been told anything. */
    roster(): MediaPeer[] {
      return this.last('media_peers')?.peers ?? [];
    },
    disconnect() {
      removeClient(ws);
    },
  };
}

type Conn = ReturnType<typeof connect>;

/**
 * A scoring device paired to this frontend and grabbed, willing to share, and **nominated** as the
 * board camera.
 *
 * Both gates, because that is what it takes to be visible to anybody — see shared/media.ts. The
 * tests below that care about one gate at a time open them separately.
 */
function pairDevice(frontend: Conn, name?: string, tier: MediaTier = 'video') {
  const scorer = pairSilentDevice(frontend, name, tier);
  frontend.send({ type: 'media_select_camera', deviceId: scorer.deviceId });
  return scorer;
}

/** Paired, grabbed and willing — but nobody has nominated it, so it is nobody's board camera. */
function pairSilentDevice(frontend: Conn, name?: string, tier: MediaTier = 'video') {
  frontend.send({ type: 'create_pairing_code' });
  const code = frontend.last('pairing_code')!.code;

  const scorer = connect();
  scorer.send({ type: 'scorer_pair', code });
  const announced = frontend.last('device_paired')!;
  frontend.send({
    type: 'activate_devices',
    devices: [{ deviceId: announced.deviceId, tokenHash: announced.tokenHash, grabbedAt: 1 }],
  });
  if (name) scorer.send({ type: 'scorer_name', name });
  if (tier !== 'disabled') scorer.send({ type: 'media_ready', tier });
  return Object.assign(scorer, { deviceId: announced.deviceId });
}

/** An online lobby with a player each, both taking part in media. */
function onlineLobby() {
  const host = connect();
  host.send({ type: 'create_lobby', isLocal: false });
  const lobbyId = host.last('lobby_state')!.lobby.id;
  host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });

  const guest = connect();
  guest.send({ type: 'join_lobby', lobbyId, playerName: 'Bob' });
  guest.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });

  host.send({ type: 'media_ready', tier: 'video' });
  guest.send({ type: 'media_ready', tier: 'video' });
  return { host, guest, lobbyId };
}

/** Watch a lobby or match, and take part in media. */
function spectate(id: string) {
  const watcher = connect();
  watcher.send({ type: 'spectate', id });
  watcher.send({ type: 'media_ready', tier: 'video' });
  return watcher;
}

const idsIn = (conn: Conn) => conn.roster().map((p) => p.peerId).sort();
const entryFor = (conn: Conn, other: Conn) => conn.roster().find((p) => p.peerId === other.peerId());

beforeEach(() => {
  resetDeviceRegistry();
});

afterEach(() => {
  for (const ws of openSockets.splice(0)) removeClient(ws);
  resetDeviceRegistry();
});

// ============================================================
// Who is offered whom
// ============================================================

describe('the roster', () => {
  it('pairs the two participants and every camera with both of them, and never two cameras', () => {
    const { host, guest } = onlineLobby();
    const hostCam = pairDevice(host, 'Alice board');
    const guestCam = pairDevice(guest, 'Bob board');

    // Each user sees the opponent and both boards.
    expect(idsIn(host)).toEqual([guest, hostCam, guestCam].map((c) => c.peerId()!).sort());
    expect(idsIn(guest)).toEqual([host, hostCam, guestCam].map((c) => c.peerId()!).sort());

    // A camera sees the two users and never the other camera: two phones pointed at two boards
    // have nothing to say to each other.
    expect(idsIn(hostCam)).toEqual([host, guest].map((c) => c.peerId()!).sort());
    expect(idsIn(guestCam)).toEqual([host, guest].map((c) => c.peerId()!).sort());
  });

  it('tells a viewer which player a camera is watching, and what it is called', () => {
    const { host, guest } = onlineLobby();
    const hostCam = pairDevice(host, 'Alice board');

    // The opponent's view of the other board: named by the device itself, attributed to its owner's
    // player, so a screen can put it beside the right card.
    const seenByOpponent = entryFor(guest, hostCam)!;
    expect(seenByOpponent.kind).toBe('device');
    expect(seenByOpponent.label).toBe('Alice board');
    expect(seenByOpponent.playerId).toBe(host.last('lobby_state')!.lobby.players[0].id);

    expect(entryFor(guest, host)!.label).toBe('Alice');
    expect(entryFor(host, guest)!.label).toBe('Bob');
  });

  it('offers a local match only its own cameras — there is no opponent to offer', () => {
    const user = connect();
    user.send({ type: 'create_lobby', isLocal: true });
    const lobbyId = user.last('lobby_state')!.lobby.id;
    user.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    user.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
    user.send({ type: 'media_ready', tier: 'video' });

    const camera = pairDevice(user);
    expect(idsIn(user)).toEqual([camera.peerId()!]);
    // One user holds every player, so which player's board this is has no answer.
    expect(entryFor(user, camera)!.playerId).toBeUndefined();
  });

  it('gives the two sides of every pair opposite politeness', () => {
    const { host, guest } = onlineLobby();
    const camera = pairDevice(host);

    for (const [a, b] of [[host, guest], [host, camera], [guest, camera]] as const) {
      expect(entryFor(a, b)!.polite).toBe(!entryFor(b, a)!.polite);
    }
  });

  it('does not offer anybody a peer in another match', () => {
    const first = onlineLobby();
    const second = onlineLobby();
    pairDevice(first.host);

    for (const conn of [second.host, second.guest]) {
      expect(idsIn(conn)).toEqual([conn === second.host ? second.guest : second.host].map((c) => c.peerId()!));
    }
  });

  it('says nothing to a connection that has not opted in, and forgets one that opts back out', () => {
    const host = connect();
    host.send({ type: 'create_lobby', isLocal: false });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });

    const guest = connect();
    guest.send({ type: 'join_lobby', lobbyId, playerName: 'Bob' });
    guest.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });

    // Only one of them wants media. There is nobody to pair it with.
    host.send({ type: 'media_ready', tier: 'video' });
    expect(host.roster()).toEqual([]);
    expect(guest.count('media_peers')).toBe(0);

    guest.send({ type: 'media_ready', tier: 'video' });
    expect(idsIn(host)).toEqual([guest.peerId()!]);

    // And opting out empties the other side's roster, which is what closes the link.
    guest.send({ type: 'media_leave' });
    expect(host.roster()).toEqual([]);
  });
});

// ============================================================
// The two gates on a board camera
// ============================================================

describe('a board camera', () => {
  it('is offered to nobody until its owner nominates it, however willing the phone is', () => {
    const { host, guest } = onlineLobby();
    const camera = pairSilentDevice(host, 'Alice board');

    // The phone has said it will share. Nobody asked for it, so nobody can see it — not its own
    // owner and certainly not the opponent.
    expect(camera.roster()).toEqual([]);
    expect(entryFor(host, camera)).toBeUndefined();
    expect(entryFor(guest, camera)).toBeUndefined();

    host.send({ type: 'media_select_camera', deviceId: camera.deviceId });
    expect(idsIn(camera)).toEqual([host, guest].map((c) => c.peerId()!).sort());
  });

  it('is offered to nobody if the phone declined, however hard its owner tries', () => {
    const { host, guest } = onlineLobby();
    const camera = pairSilentDevice(host, 'Alice board', 'disabled');

    host.send({ type: 'media_select_camera', deviceId: camera.deviceId });

    // The phone's answer is the phone's. Nominating it changes nothing.
    expect(camera.roster()).toEqual([]);
    expect(entryFor(host, camera)).toBeUndefined();
    expect(entryFor(guest, camera)).toBeUndefined();
  });

  it('takes the opponent’s view away when its owner nominates nobody', () => {
    const { host, guest } = onlineLobby();
    const camera = pairDevice(host, 'Alice board');
    expect(entryFor(guest, camera)).toBeDefined();

    host.send({ type: 'media_select_camera', deviceId: null });

    // One choice, two viewers: opting out is not something the opponent can work around.
    expect(entryFor(guest, camera)).toBeUndefined();
    expect(entryFor(host, camera)).toBeUndefined();
    expect(camera.roster()).toEqual([]);
  });

  it('is one at a time — nominating another releases the first', () => {
    const { host, guest } = onlineLobby();
    const first = pairDevice(host, 'Board A');
    const second = pairSilentDevice(host, 'Board B');

    host.send({ type: 'media_select_camera', deviceId: second.deviceId });

    expect(idsIn(guest)).toEqual([host, second].map((c) => c.peerId()!).sort());
    expect(first.roster()).toEqual([]);
  });

  it('cannot be nominated by somebody who does not hold it', () => {
    const { host, guest } = onlineLobby();
    const camera = pairSilentDevice(host, 'Alice board');

    // The opponent knows this device exists — it is about to be in their roster — but naming it is
    // not the same as holding it.
    guest.send({ type: 'media_select_camera', deviceId: camera.deviceId });

    expect(camera.roster()).toEqual([]);
    expect(entryFor(guest, camera)).toBeUndefined();
  });

  it('carries what it is willing to send, and says so again when that changes', () => {
    const { host, guest } = onlineLobby();
    const camera = pairDevice(host, 'Alice board', 'stills');
    expect(entryFor(guest, camera)!.tier).toBe('stills');

    // A phone changing its mind keeps its peer id — a new one would tear down a live link.
    const before = camera.peerId();
    camera.send({ type: 'media_ready', tier: 'video' });
    expect(camera.peerId()).toBe(before);
    expect(entryFor(guest, camera)!.tier).toBe('video');

    // And its owner is told what it offers, since that list is where a board camera is chosen.
    expect(host.last('devices_state')!.devices[0].media).toBe('video');
  });

  it('is marked as its owner’s, and as nobody else’s', () => {
    const { host, guest, lobbyId } = onlineLobby();
    const camera = pairDevice(host, 'Alice board');
    const watcher = spectate(lobbyId);

    // The one edge that carries ownership, stated from both ends.
    expect(entryFor(camera, host)!.own).toBe(true);
    expect(entryFor(host, camera)!.own).toBe(true);

    // And nowhere else. This is what a device checks before it will photograph anything, so an
    // opponent or a spectator being marked here would be them deciding what somebody else's camera
    // points at.
    expect(entryFor(camera, guest)!.own).toBe(false);
    expect(entryFor(guest, camera)!.own).toBe(false);
    expect(entryFor(camera, watcher)!.own).toBe(false);
    expect(entryFor(watcher, camera)!.own).toBe(false);
    // Never between two frontends: neither of them is anybody's camera.
    expect(entryFor(host, guest)!.own).toBe(false);
  });

  it('is its owner’s even when the owner holds every player', () => {
    const user = connect();
    user.send({ type: 'create_lobby', isLocal: true });
    const lobbyId = user.last('lobby_state')!.lobby.id;
    user.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    user.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
    user.send({ type: 'media_ready', tier: 'video' });
    const camera = pairDevice(user);

    // A local match has no player id to identify anybody by, which is exactly why `own` exists as a
    // flag of its own: it is the only way this frontend can pick its own camera out of the roster.
    expect(entryFor(user, camera)!.playerId).toBeUndefined();
    expect(entryFor(user, camera)!.own).toBe(true);
    expect(entryFor(camera, user)!.own).toBe(true);
  });

  it('never receives, at either end of the sentence', () => {
    const { host, guest } = onlineLobby();
    const camera = pairDevice(host, 'Alice board');

    // A board camera publishes. It has no business decoding anybody's picture, and a phone already
    // running a detection model should not be handed a decoder.
    for (const entry of camera.roster()) {
      expect(entry.send).toBe(false);
      expect(entry.recv).toBe(true);
    }
    for (const viewer of [host, guest]) {
      const seen = entryFor(viewer, camera)!;
      expect(seen.send).toBe(true);
      expect(seen.recv).toBe(false);
    }

    // Between two frontends it stays symmetric: either may grow a player camera later.
    expect(entryFor(host, guest)).toMatchObject({ send: true, recv: true });
  });
});

// ============================================================
// Spectators
// ============================================================

describe('spectators', () => {
  it('may watch everybody and be watched by nobody', () => {
    const { host, guest, lobbyId } = onlineLobby();
    const camera = pairDevice(host);
    const watcher = spectate(lobbyId);

    expect(idsIn(watcher)).toEqual([host, guest, camera].map((c) => c.peerId()!).sort());
    // Every peer may send to the spectator; the spectator may send to none of them.
    for (const entry of watcher.roster()) {
      expect(entry.send).toBe(true);
      expect(entry.recv).toBe(false);
    }
    const seenByHost = entryFor(host, watcher)!;
    expect(seenByHost.send).toBe(false);
    expect(seenByHost.recv).toBe(true);
  });

  it('admits only so many, and the ones beyond that are offered nobody', () => {
    const { host, lobbyId } = onlineLobby();

    const admitted = Array.from({ length: MEDIA_VIEWERS_PER_ROOM }, () => spectate(lobbyId));
    for (const watcher of admitted) expect(idsIn(watcher)).toContain(host.peerId()!);

    // An audience is uncapped per match by design; media is not, because every viewer is another
    // link on somebody's phone.
    const turnedAway = spectate(lobbyId);
    expect(turnedAway.roster()).toEqual([]);
    expect(entryFor(host, turnedAway)).toBeUndefined();
  });

  it('never pairs two spectators — neither of them may send', () => {
    const { lobbyId } = onlineLobby();
    const first = spectate(lobbyId);
    const second = spectate(lobbyId);

    expect(entryFor(first, second)).toBeUndefined();
    expect(entryFor(second, first)).toBeUndefined();
  });

  it("does not make a publisher of a spectator's own camera", () => {
    const { host, lobbyId } = onlineLobby();
    const watcher = spectate(lobbyId);
    const watcherCam = pairDevice(watcher);

    // The same rule as scoring: a spectator with a paired camera must not become a source.
    expect(entryFor(host, watcherCam)).toBeUndefined();
    expect(watcherCam.roster()).toEqual([]);
  });
});

// ============================================================
// Moving between rooms
// ============================================================

describe('following the match', () => {
  it('says nothing when a match starts — the same people are still in the room', () => {
    const { host, guest, lobbyId } = onlineLobby();
    pairDevice(host);
    const before = host.count('media_peers');
    const rosterBefore = host.roster();

    host.send({ type: 'start_match', lobbyId });

    // The lobby became a match and every client moved with it. Nobody's peers changed, so nobody is
    // told anything — a republished roster here would tear down a link that is carrying video.
    expect(host.count('media_peers')).toBe(before);
    expect(host.roster()).toEqual(rosterBefore);
  });

  it('carries a link through a re-match untouched', () => {
    const { host, guest, lobbyId } = onlineLobby();
    const camera = pairDevice(host);
    // Straight out from 180, so one visit of three trebles wins the whole thing.
    host.send({
      type: 'update_settings',
      lobbyId,
      settings: { mode: 'x01', modeSettings: { startScore: 180, doubleIn: false, doubleOut: false } },
    });
    host.send({ type: 'start_match', lobbyId });

    const match = host.last('match_started')!.match;
    const first = match.id;
    const thrower = match.players[match.currentPlayerIndex].id === host.playerId() ? host : guest;
    const T20 = { x: 500_000, y: 726_000 };
    for (let i = 0; i < 3; i++) thrower.send({ type: 'add_dart', matchId: first, dart: T20 });
    thrower.send({ type: 'submit_visit', matchId: first });
    // A mode declaring a winner arrives as an ordinary state broadcast, not as `match_finished`.
    expect(host.last('match_state')!.match.status).toBe('finished');

    const before = { host: host.count('media_peers'), camera: camera.count('media_peers') };
    const rosterBefore = host.roster();

    for (const conn of [host, guest]) {
      conn.send({ type: 'rematch_vote', matchId: first, playerId: conn.playerId()!, answer: 'accepted' });
    }

    // A re-match is a brand new match id and exactly the same people. Nobody is told anything,
    // because a republished roster here is what would tear down a link carrying video.
    expect(host.last('match_started')!.match.id).not.toBe(first);
    expect(host.count('media_peers')).toBe(before.host);
    expect(camera.count('media_peers')).toBe(before.camera);
    expect(host.roster()).toEqual(rosterBefore);
  });

  it('empties the roster of somebody who leaves, and of everyone who could see them', () => {
    const { host, guest, lobbyId } = onlineLobby();
    host.send({ type: 'start_match', lobbyId });
    const matchId = host.last('match_started')!.match.id;
    expect(idsIn(host)).toEqual([guest.peerId()!]);

    guest.send({ type: 'leave_match', matchId });

    expect(guest.roster()).toEqual([]);
    expect(host.roster()).toEqual([]);
  });

  it('empties the roster of everyone left behind when a peer disconnects', () => {
    const { host, guest } = onlineLobby();
    const camera = pairDevice(host);
    expect(idsIn(guest)).toContain(camera.peerId()!);

    camera.disconnect();

    expect(idsIn(guest)).toEqual([host.peerId()!]);
    expect(idsIn(host)).toEqual([guest.peerId()!]);
  });
});

// ============================================================
// The relay
// ============================================================

const OFFER = { type: 'offer' as const, sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' };

describe('signaling', () => {
  it('hands a description to the peer it is addressed to, and to nobody else', () => {
    const { host, guest } = onlineLobby();
    const camera = pairDevice(host);

    host.send({ type: 'media_signal', to: camera.peerId(), description: OFFER });

    expect(camera.last('media_signal')).toEqual({
      type: 'media_signal', from: host.peerId(), description: OFFER,
    });
    expect(guest.count('media_signal')).toBe(0);
  });

  it('refuses a peer in another match, in silence', () => {
    const first = onlineLobby();
    const second = onlineLobby();

    first.host.send({ type: 'media_signal', to: second.host.peerId(), description: OFFER });

    expect(second.host.count('media_signal')).toBe(0);
    // Silence, not an error: a peer learns where it stands from its roster, and an error frame
    // would only race it.
    expect(first.host.count('error')).toBe(0);
  });

  it('refuses a peer that was in the roster a moment ago', () => {
    const { host, guest, lobbyId } = onlineLobby();
    host.send({ type: 'start_match', lobbyId });
    const matchId = host.last('match_started')!.match.id;
    const stale = guest.peerId()!;

    guest.send({ type: 'leave_match', matchId });
    host.send({ type: 'media_signal', to: stale, description: OFFER });

    // The roster is recomputed when the message lands, never remembered, which is what closes the
    // window on a signal that was already in flight when somebody walked out.
    expect(guest.count('media_signal')).toBe(0);
  });

  it('refuses a signal from a connection that never opted in', () => {
    const { host } = onlineLobby();
    const target = host.peerId()!;

    const stranger = connect();
    stranger.send({ type: 'media_signal', to: target, description: OFFER });

    expect(host.count('media_signal')).toBe(0);
  });

  it('drops a malformed or oversized description', () => {
    const { host } = onlineLobby();
    const camera = pairDevice(host);
    const to = camera.peerId();

    host.send({ type: 'media_signal', to, description: { type: 'rollback', sdp: 'x' } });
    host.send({ type: 'media_signal', to, description: { type: 'offer' } });
    host.send({ type: 'media_signal', to, description: { type: 'offer', sdp: '' } });
    host.send({ type: 'media_signal', to, description: { type: 'offer', sdp: 'x'.repeat(8193) } });
    host.send({ type: 'media_signal', to, description: 'not an object' });

    expect(camera.count('media_signal')).toBe(0);

    // And the same peer with a good description still works, so nothing above wedged the link.
    host.send({ type: 'media_signal', to, description: OFFER });
    expect(camera.count('media_signal')).toBe(1);
  });

  it('lets a scoring device signal, and still keeps it out of the gameplay handlers', () => {
    const { host, guest, lobbyId } = onlineLobby();
    const camera = pairDevice(host);

    camera.send({ type: 'media_signal', to: guest.peerId(), description: OFFER });
    expect(guest.count('media_signal')).toBe(1);

    // `media_` is the one prefix a device may speak besides `scorer_`. It buys it nothing else.
    camera.send({ type: 'start_match', lobbyId });
    expect(camera.count('match_started')).toBe(0);
    expect(host.count('match_started')).toBe(0);
  });
});
