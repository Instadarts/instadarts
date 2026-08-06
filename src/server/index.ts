import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { handleMessage, registerClient, removeClient, handleClientLeave, scheduleDisconnect } from './wsHandler';
import { X01Handler } from './modes/x01';
import { registerModeHandler } from './modes/types';
import { getAllLobbies, getAllGames } from './store';

// Register game modes
registerModeHandler('x01', new X01Handler());

// Start garbage collector
import { startGC, getGCStats } from './gc';
startGC();

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 16 * 1024, // 16KB max message size
});

// Server stats endpoint
app.get('/server-stats', (_req, res) => {
  const lobbies = getAllLobbies();
  const games = getAllGames();
  const runningGames = [...games.values()].filter(g => g.status === 'in_progress').length;
  const mem = process.memoryUsage();
  res.json({
    openLobbies: lobbies.size,
    runningMatches: runningGames,
    totalGames: games.size,
    connectedClients: wss.clients.size,
    gc: getGCStats(),
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Only serve static files in production (dev uses Vite on port 5173)
if (process.env.NODE_ENV === 'production') {
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

wss.on('connection', (ws) => {
  console.log('Client connected');
  const sessionId = crypto.randomUUID();
  registerClient(ws, { sessionId, lobbyId: null, gameId: null, playerId: null, isSpectator: false, deviceId: null });
  ws.send(JSON.stringify({ type: 'connected', sessionId }));

  ws.on('message', (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    console.log('Client disconnected');
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
