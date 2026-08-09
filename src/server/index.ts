import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
// Importing wsHandler also registers the lifecycle handlers — it is the module that knows what to
// tell people when a deadline passes, and it says so to `lifecycle` on load.
import { handleMessage, registerClient, removeClient, handleClientLeave, scheduleDisconnect } from './wsHandler';
import { loadModes } from './modes/types';
import { getAllLobbies, getAllMatches } from './store';
import { scoringSessionCount } from './scoring/store';
import { mediaPeerCount } from './media';
import { canAcceptConnection, capacityLimits } from './capacity';
import { clientCount } from './connections';
import { startLifecycle } from './lifecycle';
import { startHeartbeat } from './heartbeat';
import { IS_PRODUCTION, QUIET } from './env';

// Find the installed game modes. A deployment adds or removes one by adding or removing a file in
// src/server/modes/ — and one without x01 is not a deployment we will start.
const installedModes = await loadModes();
if (!QUIET) console.log(`Game modes: ${installedModes.map((m) => m.id).join(', ')}`);

// The clock that gives every lobby and match a definite end. There is no collector besides it:
// nothing here is reclaimed by being noticed later, only by its own deadline arriving.
startLifecycle();

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 16 * 1024, // 16KB max message size
});

/**
 * What the server is currently holding, and how much memory that is costing.
 *
 * Also the readiness probe the e2e run waits on, so it must stay cheap and must not depend on
 * anything that is still starting up.
 *
 * These are retention numbers rather than activity numbers. Every object counted here has a
 * deadline, so each should return to zero on an idle server; one that climbs while nothing is being
 * played is the shape a leak would take. `heldMatches` above `runningMatches` is only summaries
 * counting down — it is the two together, staying up, that would mean something.
 */
app.get('/server-stats', (_req, res) => {
  const lobbies = getAllLobbies();
  const matches = getAllMatches();
  const runningMatches = [...matches.values()].filter(g => g.status === 'in_progress').length;
  const mem = process.memoryUsage();
  res.json({
    openLobbies: lobbies.size,
    runningMatches,
    heldMatches: matches.size,
    scoringSessions: scoringSessionCount(),
    mediaPeers: mediaPeerCount(),
    connectedClients: wss.clients.size,
    capacity: capacityLimits(),
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Only serve static files in production (dev uses Vite on port 5173)
if (IS_PRODUCTION) {
  // Cross-origin isolation, or LiteRT silently runs single-threaded on the scoring device. The
  // headers have to reach the WASM worker script itself too, which is why they go on everything
  // rather than only on the document. Nothing this app loads is cross-origin, so that costs us
  // nothing — and note it must NOT include Permissions-Policy: camera=(), which would kill
  // getUserMedia on the scoring device.
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });
  app.use(express.static('dist/client'));
  // SPA fallback: serve index.html for all non-API routes
  app.get('/{*splat}', (_req, res) => {
    res.sendFile('index.html', { root: 'dist/client' });
  });
}

// Cuts connections that stopped answering without closing — the only way a vanished phone is ever
// noticed, since nothing else on the server distinguishes it from a quiet one.
startHeartbeat(wss);

wss.on('connection', (ws) => {
  // Refused here rather than later: a connection turned away at the handshake costs nothing to
  // hold, and holding it is the resource that ran out. 1013 is "try again later", which the
  // client's reconnect already treats as a reason to come back.
  if (!canAcceptConnection(clientCount())) {
    ws.close(1013, 'Server at capacity');
    return;
  }

  if (!QUIET) console.log('Client connected');
  const sessionId = crypto.randomUUID();
  registerClient(ws, { sessionId, lobbyId: null, matchId: null, playerId: null, isSpectator: false, deviceId: null });
  ws.send(JSON.stringify({ type: 'connected', sessionId }));

  ws.on('message', (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    if (!QUIET) console.log('Client disconnected');
    // Use a grace period before processing leave, so page reloads can reconnect
    scheduleDisconnect(ws, () => {
      handleClientLeave(ws);
      removeClient(ws);
    });
  });
});

server.listen(PORT, () => {
  console.log(`InstaDarts server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
