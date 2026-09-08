import './nodeVersion';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { styleText } from 'node:util';
import { WebSocketServer } from 'ws';
// Importing wsHandler also registers the lifecycle handlers — it is the module that knows what to
// tell people when a deadline passes, and it says so to `lifecycle` on load.
import { handleMessage, registerClient, removeClient, handleClientLeave, scheduleDisconnect } from './wsHandler';
import './modes/registry.js';
import { validateModeCatalog } from './modes/types';
import { getAllLobbies, getAllMatches } from './store';
import { scoringSessionCount } from './scoring/store';
import { mediaPeerCount, reportInternalStun, startInternalStun } from './media';
import { canAcceptConnection, capacityLimits } from './capacity';
import { clientCount } from './connections';
import { startLifecycle } from './lifecycle';
import { startHeartbeat } from './heartbeat';
import { DEV_CLIENT, QUIET } from './env';
import { CONFIG, CONFIG_FATAL, reportConfig } from './config';
import { listenAddresses, listenUrls } from './listenUrls';
import { createClientServing } from './staticServing';
import { createDevClient } from './devClient';
import { resolveCertificate, type ResolvedCertificate } from './certificate';
import { isWebSocketOriginAllowed } from './websocketOrigin';
import { handleApi } from './api';

// What this deployment was tuned to, and anything its settings file got wrong. Said first, because
// everything below is sized by it — and a settings file that could not be read at all stops us here,
// with the reason and nothing else. A deployment that believes it is configured and is not is worse
// than one that will not start.
if (CONFIG_FATAL) {
  console.error(CONFIG_FATAL);
  process.exit(1);
}
reportConfig();

// Validate the modes registered by the imports in src/server/modes/registry.ts. Adding or removing
// a mode requires updating that registry; x01 is required for startup.
const installedModes = validateModeCatalog();
if (!QUIET) console.log(`Game modes: ${installedModes.map((m) => m.id).join(', ')}`);

// Sweep lobby and match deadlines. Socket cleanup and heartbeat detection have separate lifetimes.
startLifecycle();

// The STUN server, if this deployment carries one. Before the HTTP listener rather than after, so
// that the first client to connect is already told the truth about whether it came up.
await startInternalStun();

// The addresses this machine can be reached at. Read once: the startup banner turns them into urls
// and the self-signed certificate turns them into the names it is valid for, and those two must be
// the same list or a phone is handed an address the certificate does not cover.
const ADDRESSES = listenAddresses();

// The certificate, before anything is listening, so a deployment that named one it cannot read
// fails here rather than on the first connection. `null` when this run serves no TLS at all.
let certificate: ResolvedCertificate | null = null;
if (CONFIG.server.https.enabled) {
  try {
    certificate = resolveCertificate(ADDRESSES);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

/**
 * Where WebSocket upgrades are answered, whichever listener they arrived on.
 *
 * It never listens. It exists so that one set of handlers — ours below, and Vite's hot-reload
 * socket — serves every listener rather than being registered once per scheme: a handshake needs
 * the socket, not the server object that happened to emit it. It is also what lets the dev client
 * work over TLS at all, since `https.Server` is not an `http.Server` and Vite will only attach to
 * the latter.
 */
const upgrades = createServer();

const handle = (req: IncomingMessage, res: ServerResponse): void => {
  void route(req, res);
};

// The client this run serves: Vite, mounted on the hub and building on demand, or the build —
// embedded in instadarts.mjs or read from CLIENT_DIR — or nothing at all. One handler either way,
// so that everything below this line is indifferent to which it got, and one for both listeners.
// Before `listen`, so that answering `/server-stats` also means the client is ready to be asked for.
const serveClient = (await createDevClient(upgrades)) ?? createClientServing();

// `noServer`, and the upgrade routed by hand below. Handing a server to `ws` instead would have it
// answer 400 to every upgrade that is not `/ws` — including Vite's hot-reload socket, which lives
// on the same hub and is entitled to its own.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024, // 16KB max message size
});

upgrades.on('upgrade', (req, socket, head) => {
  if ((req.url ?? '').split('?')[0] !== '/ws') {
    // Vite's listener is on this hub too and takes its own, so this cannot refuse what it does not
    // recognise. Without it there is no second listener and the socket is nobody's; with it, an
    // upgrade neither of us wants is left to time out rather than risk closing a hot-reload
    // connection out from under it.
    if (!DEV_CLIENT) socket.destroy();
    return;
  }
  if (!isWebSocketOriginAllowed(req, CONFIG.server.allowedOrigins)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/** A listener, and the one line of wiring that makes its upgrades the hub's problem. */
function listener(server: Server): Server {
  server.on('upgrade', (req, socket, head) => upgrades.emit('upgrade', req, socket, head));
  return server;
}

/**
 * What the server is currently holding, and how much memory that is costing.
 *
 * Also the readiness probe the e2e run waits on, so it must stay cheap and must not depend on
 * anything that is still starting up.
 *
 * Lobby and match counts follow room deadlines; `heldMatches` includes finished summaries waiting
 * to expire. Connections can remain while a browser is idle and answering heartbeat pings.
 * `connectedClients` counts sockets held by `wss`, not entries in the application client registry
 * used for admission, which also holds closed connections during their three-second cleanup grace.
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
 * The readiness probe, match API, and frontend are routed in that order. The readiness probe is
 * what the e2e run waits for, so it must not depend on a client being present, and it carries no
 * isolation headers because nothing embeds it. The API owns /api/ and its JSON errors; remaining
 * requests are the client's, and what it declines to answer is a 404.
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

  if (await handleApi(req, res)) return;
  if (serveClient && await serveClient(req, res)) return;

  res.statusCode = 404;
  res.end();
}

// Cuts connections that stopped answering without closing — the only way a vanished phone is ever
// noticed, since nothing else on the server distinguishes it from a quiet one.
startHeartbeat(wss);

wss.on('connection', (ws) => {
  // ws closes transport failures (including oversized messages and malformed frames) itself.
  // Handle its error event so it cannot terminate the process; the normal close handler below
  // owns application cleanup. Refused sockets also need this listener while their close is pending.
  ws.on('error', (err) => {
    if (!QUIET) console.warn('WebSocket error:', err.message);
  });

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

/**
 * What this run is listening on, said once everything is.
 *
 * The certificate line sits between the addresses and STUN for the same reason STUN sits last: it
 * is about how to reach the server rather than about the server, and putting it above the urls
 * would bury them.
 */
function reportListening(): void {
  console.log('InstaDarts server listening on:');
  if (CONFIG.server.http.enabled) {
    for (const url of listenUrls('http', CONFIG.server.http.port, ADDRESSES)) {
      console.log(`  ${styleText('green', url)}`);
    }
  }
  if (certificate) {
    for (const url of listenUrls('https', CONFIG.server.https.port, ADDRESSES)) {
      console.log(`  ${styleText('green', url)}`);
    }
  }

  if (!QUIET && certificate) {
    if (certificate.source === 'configured') {
      console.log(`HTTPS: certificate from ${CONFIG.server.https.cert}`);
    } else {
      console.log(`HTTPS: self-signed certificate for ${certificate.names.join(', ')}`);
      console.log('  Browsers warn once per device; accept it to reach the camera.');
    }
  }
  if (certificate?.notPersisted) {
    console.warn(`HTTPS: the certificate could not be saved — ${certificate.notPersisted}`);
    console.warn('  It works, but a restart makes a new one and every device is asked again.');
  }

  reportInternalStun();
}

// Both listeners answer the same handler and feed the same hub; the only difference is the TLS.
// Reported once, after the last one is up, so the banner is one block rather than a race.
const listeners = [
  ...(CONFIG.server.http.enabled
    ? [{ scheme: 'http', server: listener(createServer(handle)), port: CONFIG.server.http.port }]
    : []),
  ...(certificate
    ? [{
        scheme: 'https',
        server: listener(createTlsServer({ key: certificate.key, cert: certificate.cert }, handle)),
        port: CONFIG.server.https.port,
      }]
    : []),
];

let pending = listeners.length;
for (const { server, port, scheme } of listeners) {
  // A port already held is the ordinary way starting fails — a previous run that outlived its
  // terminal, or the other half of a pair of instances. Node's default answer is an unhandled
  // error event and a stack trace, which buries the one line that says which port and which
  // scheme. Two listeners make it twice as likely, so say it and stop.
  server.on('error', (err: NodeJS.ErrnoException) => {
    const reason = err.code === 'EADDRINUSE'
      ? `port ${port} is already in use`
      : `${err.code ?? 'error'}: ${err.message}`;
    console.error(`InstaDarts could not listen for ${scheme} — ${reason}`);
    process.exit(1);
  });

  server.listen(port, () => {
    pending -= 1;
    if (pending === 0) reportListening();
  });
}
