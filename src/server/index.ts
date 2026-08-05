import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { handleMessage, registerClient, removeClient, handleClientLeave } from './wsHandler';
import { X01Handler } from './modes/x01';
import { registerModeHandler } from './modes/types';

// Register game modes
registerModeHandler('x01', new X01Handler());

// Start garbage collector
import { startGC } from './gc';
startGC();

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Only serve static files in production (dev uses Vite on port 5173)
if (process.env.NODE_ENV === 'production') {
  app.use(express.static('dist/client'));
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  registerClient(ws, { lobbyId: null, gameId: null, playerId: null, isHost: false });

  ws.on('message', (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    handleClientLeave(ws);
    removeClient(ws);
  });

  ws.send(JSON.stringify({ type: 'connected', message: 'Welcome to InstaDarts!' }));
});

server.listen(PORT, () => {
  console.log(`InstaDarts server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
