import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import { resetDeviceRegistry } from '../../src/server/devices';
import { resetScoringSessions } from '../../src/server/scoring/store';
import { scoringContextId } from '../../src/server/scoring/store';
import { releaseRateLimit } from '../../src/server/rateLimit';
import { deleteLobby, deleteMatch, getAllLobbies, getAllMatches } from '../../src/server/store';
import type { ServerMessage } from '../../src/shared/protocol';
import '../helpers'; // registers the x01 mode

/**
 * What a scoring device is told, and who is allowed to tell it.
 *
 * Two things live here. `scoring` is what a device powers itself down by, so it has to mean exactly
 * what the server means when it decides whether to accept tips — the same question, asked once. And
 * a command is the first thing a frontend can make another person's hardware do, so the claim being
 * the only authority for it is worth a test of its own.
 */

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

  registerClient(ws, { sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null });
  openSockets.push(ws);

  return {
    ws,
    sessionId,
    received,
    send(msg: object) {
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
  };
}

type Conn = ReturnType<typeof connect>;

function pairTo(frontend: Conn) {
  frontend.send({ type: 'create_pairing_code' });
  const code = frontend.last('pairing_code')!.code;

  const scorer = connect();
  scorer.send({ type: 'scorer_pair', code });
  const { deviceId, token } = scorer.last('scorer_paired')!;
  const { tokenHash } = frontend.last('device_paired')!;
  frontend.send({ type: 'activate_devices', devices: [{ deviceId, tokenHash, grabbedAt: 1 }] });

  return { scorer, deviceId, token, tokenHash };
}

/** A frontend with a device paired to it, and a local lobby ready to start. */
function setup() {
  const frontend = connect();
  const { scorer, deviceId, token, tokenHash } = pairTo(frontend);
  frontend.send({ type: 'create_lobby', acceptsJoins: false });
  frontend.send({ type: 'add_local_player', playerName: 'Alice' });
  frontend.send({ type: 'add_local_player', playerName: 'Bob' });
  return { frontend, scorer, deviceId, token, tokenHash };
}

const scoring = (conn: Conn) => conn.last('scorer_state')?.scoring;

it('gives different player boards in one match different opaque contexts', () => {
  const alice = scoringContextId('match-a', 'player-a');
  const bob = scoringContextId('match-a', 'player-b');
  expect(alice).not.toBe(bob);
  expect(alice).not.toContain('match-a');
  expect(alice).not.toContain('player-a');
});

beforeEach(() => {
  resetDeviceRegistry();
  resetScoringSessions();
});

afterEach(() => {
  for (const ws of openSockets.splice(0)) removeClient(ws);
  for (const id of [...getAllLobbies().keys()]) deleteLobby(id);
  for (const id of [...getAllMatches().keys()]) deleteMatch(id);
});

describe('a device learning whether it is wanted', () => {
  it('is not scoring merely because a frontend claimed it', () => {
    // The gap this closes: a device claimed all evening between legs used to be told 'active', which
    // it had no way to tell apart from actually feeding a match.
    const { scorer } = setup();
    expect(scorer.last('scorer_state')!.status).toBe('active');
    expect(scoring(scorer)).toBe(false);
    expect(scorer.last('scorer_state')!.scoringContextId).toBeNull();
  });

  it('is told the moment a match starts, not on the first dart', () => {
    // The load-bearing push. A camera that powered itself down has nothing else to bring it back.
    const { frontend, scorer } = setup();
    const before = scorer.count('scorer_state');

    frontend.send({ type: 'start_match' });

    expect(scorer.count('scorer_state')).toBeGreaterThan(before);
    expect(scoring(scorer)).toBe(true);
    expect(scorer.last('scorer_state')!.scoringContextId).not.toBeNull();
  });

  it('keeps a context stable across publications and a scorer reconnect', () => {
    const { frontend, scorer, deviceId, token } = setup();
    frontend.send({ type: 'start_match' });
    const context = scorer.last('scorer_state')!.scoringContextId;
    expect(context).not.toBeNull();

    frontend.send({ type: 'add_dart', dart: { x: 500_000, y: 500_000 } });
    expect(scorer.last('scorer_state')!.scoringContextId).toBe(context);

    const replacement = connect();
    replacement.send({ type: 'scorer_hello', deviceId, token });
    expect(replacement.last('scorer_state')!.scoringContextId).toBe(context);
  });

  it('uses a new context for the next match', () => {
    const { frontend, scorer } = setup();
    frontend.send({ type: 'start_match' });
    const first = scorer.last('scorer_state')!.scoringContextId;

    frontend.send({ type: 'leave_match' });
    expect(scorer.last('scorer_state')!.scoringContextId).toBeNull();
    frontend.send({ type: 'create_lobby', acceptsJoins: false });
    frontend.send({ type: 'add_local_player', playerName: 'Alice' });
    frontend.send({ type: 'start_match' });

    const second = scorer.last('scorer_state')!.scoringContextId;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('is told again when the match is left', () => {
    const { frontend, scorer } = setup();
    frontend.send({ type: 'start_match' });
    expect(scoring(scorer)).toBe(true);

    frontend.send({ type: 'leave_match' });
    expect(scoring(scorer)).toBe(false);
  });

  it('is not scoring for a spectator, however many matches are running', () => {
    // A spectator with a paired camera must not become a scorer, and must not be told to power one
    // up for a match that will never take its tips.
    // An online match, which is where the question has teeth: a local one scores for whoever is up
    // and never consults an owner at all, so it could not tell a spectator from a player.
    const host = connect();
    host.send({ type: 'create_lobby', acceptsJoins: true });
    const lobbyId = host.last('lobby_state')!.lobby.id;
    host.send({ type: 'add_local_player', lobbyId, playerName: 'Alice' });
    const guest = connect();
    guest.send({ type: 'join_lobby', inviteCode: host.last('lobby_state')!.lobby.inviteCode! });
    guest.send({ type: 'add_local_player', lobbyId, playerName: 'Bob' });
    host.send({ type: 'start_match', lobbyId });
    const matchId = host.last('match_started')!.match.id;

    const watcher = connect();
    const { scorer } = pairTo(watcher);
    watcher.send({ type: 'spectate', id: matchId });

    expect(scoring(scorer)).toBe(false);
    deleteLobby(lobbyId);
  });

  it('is not scoring with nobody holding it', () => {
    const { frontend, scorer, deviceId } = setup();
    frontend.send({ type: 'start_match' });
    expect(scoring(scorer)).toBe(true);

    frontend.send({ type: 'deactivate_device', deviceId });
    expect(scorer.last('scorer_state')!.status).toBe('waiting');
    expect(scoring(scorer)).toBe(false);
  });
});

describe('commanding a device', () => {
  it('reaches the device that the sender holds', () => {
    const { frontend, scorer, deviceId } = setup();

    frontend.send({ type: 'set_device_camera', deviceId, active: true });
    expect(scorer.last('scorer_command')!.command).toBe('camera_on');

    frontend.send({ type: 'set_device_camera', deviceId, active: false });
    expect(scorer.last('scorer_command')!.command).toBe('camera_off');

    frontend.send({ type: 'power_off_device', deviceId });
    expect(scorer.last('scorer_command')!.command).toBe('power_off');
  });

  it('is refused to anyone who does not hold it', () => {
    // The claim is the authority. Naming somebody else's device id gets silence, not their camera.
    const { scorer, deviceId } = setup();
    const stranger = connect();

    stranger.send({ type: 'set_device_camera', deviceId, active: true });
    stranger.send({ type: 'power_off_device', deviceId });

    expect(scorer.count('scorer_command')).toBe(0);
  });

  it('is refused once the device has been handed over', () => {
    const { frontend, scorer, deviceId, tokenHash } = setup();
    const other = connect();
    other.send({ type: 'activate_devices', devices: [{ deviceId, tokenHash, grabbedAt: 2 }] });

    frontend.send({ type: 'set_device_camera', deviceId, active: true });
    expect(scorer.count('scorer_command')).toBe(0);

    other.send({ type: 'set_device_camera', deviceId, active: true });
    expect(scorer.last('scorer_command')!.command).toBe('camera_on');
  });

  it('says nothing back, whether it landed or not', () => {
    // A command is answered by the device's own `scorer_camera`, never by an acknowledgement here:
    // an owner shown "on" for a camera that never opened is worse off than one shown nothing.
    const { frontend, deviceId } = setup();
    const before = frontend.received.length;

    frontend.send({ type: 'set_device_camera', deviceId, active: true });
    frontend.send({ type: 'set_device_camera', deviceId: 'no-such-device-id-at-all', active: true });

    expect(frontend.received.slice(before)).toEqual([]);
  });

  it('is not something a scoring device can send', () => {
    // A device is not a frontend. Its connection holds no claims, so it commands nothing.
    const { scorer, deviceId } = setup();
    const before = scorer.count('scorer_command');

    scorer.send({ type: 'power_off_device', deviceId });

    expect(scorer.count('scorer_command')).toBe(before);
  });
});

describe('what a camera says about itself', () => {
  it('carries a failure through to the owner, and clears it on success', () => {
    // Only the phone knows why a camera would not open, and the person who asked for it is looking
    // at a different screen.
    const { frontend, scorer } = setup();

    scorer.send({ type: 'scorer_camera', active: false, error: 'Permission denied' });
    expect(frontend.last('devices_state')!.devices[0].cameraError).toBe('Permission denied');

    scorer.send({ type: 'scorer_camera', active: true });
    expect(frontend.last('devices_state')!.devices[0].cameraError).toBeUndefined();
    expect(frontend.last('devices_state')!.devices[0].cameraActive).toBe(true);
  });

  it('does not let a device write whatever it likes onto the owning screen', () => {
    const { frontend, scorer } = setup();

    scorer.send({ type: 'scorer_camera', active: false, error: 'x'.repeat(500) });
    expect(frontend.last('devices_state')!.devices[0].cameraError!.length).toBeLessThanOrEqual(120);

    scorer.send({ type: 'scorer_camera', active: false, error: { evil: true } });
    expect(frontend.last('devices_state')!.devices[0].cameraError).toBeUndefined();
  });
});
