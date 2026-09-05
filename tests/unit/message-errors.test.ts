import { expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import * as store from '../../src/server/store';
import { getClient } from '../../src/server/connections';
import { handleMessage, registerClient, removeClient } from '../../src/server/wsHandler';
import '../helpers';

it('contains unexpected dispatch failures and stops processing the closing connection', () => {
  function socket(sessionId: string) {
    const ws = {
      readyState: 1,
      OPEN: 1,
      send: vi.fn(),
      close: vi.fn(() => { ws.readyState = 2; }),
    };
    const connection = ws as unknown as WebSocket;
    registerClient(connection, { sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null });
    return { connection, ws };
  }
  const failed = socket('dispatch-failure');
  const healthy = socket('dispatch-healthy');
  // Independent of input validation: a future internal failure must also stay inside dispatch.
  const create = vi.spyOn(store, 'createLobby').mockImplementationOnce(() => { throw new Error('private failure detail'); });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const message = JSON.stringify({ type: 'create_lobby' });
  try {
    expect(() => handleMessage(failed.connection, message)).not.toThrow();
    expect(failed.ws.close).toHaveBeenCalledWith(1011, 'Unable to process message');
    expect(getClient(failed.connection)?.lobbyId).toBeNull();
    handleMessage(failed.connection, message);
    expect(create).toHaveBeenCalledTimes(1);

    handleMessage(healthy.connection, message);
    expect(healthy.ws.close).not.toHaveBeenCalled();
    expect(getClient(healthy.connection)?.lobbyId).toBeTruthy();
  } finally {
    create.mockRestore();
    log.mockRestore();
    for (const { connection } of [failed, healthy]) {
      const lobbyId = getClient(connection)?.lobbyId;
      if (lobbyId) store.deleteLobby(lobbyId);
      removeClient(connection);
    }
  }
});
