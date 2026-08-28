import './nodeVersion';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { styleText } from 'node:util';
import { WebSocketServer } from 'ws';
// Importing wsHandler also registers the lifecycle handlers — it is the module that knows what to
// tell people when a deadline passes, and it says so to `lifecycle` on load.
import { handleMessage, registerClient, removeClient, handleClientLeave, scheduleDisconnect } from './wsHandler';
import './modes/registry.js';
import { loadModes } from './modes/types';
import { getAllLobbies, getAllMatches } from './store';
import { scoringSessionCount } from './scoring/store';
import { mediaPeerCount, reportInternalStun, startInternalStun } from './media';
import { canAcceptConnection, capacityLimits } from './capacity';
import { clientCount } from './connections';
import { startLifecycle } from './lifecycle';
import { startHeartbeat } from './heartbeat';
import { DEV_CLIENT, QUIET } from './env';
import { CONFIG, CONFIG_FATAL, reportConfig } from './config';
import { httpListenUrls } from './listenUrls';
import { createClientServing } from './staticServing';
import { createDevClient } from './devClient';

// What this deployment was tuned to, and anything its settings file got wrong. Said first, because
// everything below is sized by it — and a settings file that could not be read at all stops us here,
// with the reason and nothing else. A deployment that believes it is configured and is not is worse
// than one that will not start.
if (CONFIG_FATAL) {
  console.error(CONFIG_FATAL);
  process.exit(1);
}
reportConfig();

// Find the installed game modes. A deployment adds or removes one by adding or removing a file in
// src/server/modes/ — and one without x01 is not a deployment we will start.
const installedModes = await loadModes();
if (!QUIET) console.log(`Game modes: ${installedModes.map((m) => m.id).join(', ')}`);

// The clock that gives every lobby and match a definite end. There is no collector besides it:
// nothing here is reclaimed by being noticed later, only by its own deadline arriving.
startLifecycle();

// The STUN server, if this deployment carries one. Before the HTTP listener rather than after, so
// that the first client to connect is already told the truth about whether it came up.
await startInternalStun();

const PORT = CONFIG.server.port;

const server = createServer((req, res) => {
  void route(req, res);
});

// The client this run serves: Vite, mounted on this same server and building on demand, or the
// build — embedded in instadarts.mjs or read from CLIENT_DIR — or nothing at all. One handler
// either way, so that everything below this line is indifferent to which it got. Before `listen`,
// so that answering `/server-stats` also means the client is ready to be asked for.
const serveClient = (await createDevClient(server)) ?? createClientServing();

// `noServer`, and the upgrade routed by hand below. Handing the server to `ws` instead would have
// it answer 400 to every upgrade that is not `/ws` — including Vite's hot-reload socket, which is
// on this same server and is entitled to its own.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024, // 16KB max message size
});

server.on('upgrade', (req, socket, head) => {
  if ((req.url ?? '').split('?')[0] !== '/ws') {
    // Vite's listener is on this server too and takes its own, so this cannot refuse what it does
    // not recognise. Without it there is no second listener and the socket is nobody's; with it, an
    // upgrade neither of us wants is left to time out rather than risk closing a hot-reload
    // connection out from under it.
    if (!DEV_CLIENT) socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
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
function serverStats() {
  const lobbies = getAllLobbies();
  const matches = getAllMatches();
  const runningMatches = [...matches.values()].filter(g => g.status === 'in_progress').length;
  const mem = process.memoryUsage();
  return {
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
  };
}

/**
 * Every request that is not a WebSocket upgrade — those never reach here, because the upgrade is a
 * different event on the same server.
 *
 * Two things to be, in this order. The readiness probe answers first and on its own terms: it is
 * what the e2e run waits for, so it must not depend on a client being present, and it carries no
 * isolation headers because nothing embeds it. Everything else is the client's, and what the
 * client declines to answer is a 404 — there is no third handler behind it.
 */
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = (req.url ?? '').split('?')[0];

  if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/server-stats') {
    const body = JSON.stringify(serverStats());
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  if (serveClient && await serveClient(req, res)) return;

  res.statusCode = 404;
  res.end();
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
  registerClient(ws, { sessionId, lobbyId: null, matchId: null, isSpectator: false, deviceId: null });
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
  console.log('InstaDarts server listening on:');
  for (const url of httpListenUrls(PORT)) console.log(`  ${styleText('green', url)}`);
  reportInternalStun();
});
