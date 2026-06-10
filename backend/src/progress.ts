import { WebSocket, WebSocketServer } from 'ws';
import { Server } from 'http';
import logger from './logger';
import { tasks, taskEvents } from './database';

interface HeartbeatSocket extends WebSocket {
  isAlive: boolean;
}

let wss: WebSocketServer;

export function initWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const socket = ws as HeartbeatSocket;
      if (!socket.isAlive) {
        socket.terminate();
        return;
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws) => {
    const socket = ws as HeartbeatSocket;
    socket.isAlive = true;

    socket.on('pong', () => { socket.isAlive = true; });

    logger.info('WebSocket client connected');
    socket.on('close', () => logger.info('WebSocket client disconnected'));

    // Send current active tasks so the client has immediate state
    const pending = tasks.getPending();
    if (pending.length > 0) {
      socket.send(JSON.stringify({ type: 'initial_state', tasks: pending }));
    }
  });
}

export function setupTaskBroadcasts() {
  taskEvents.on('task:created', (task) => {
    broadcast({ type: 'task_created', task });
  });
  taskEvents.on('task:updated', (task) => {
    broadcast({ type: 'task_updated', task });
  });
}

export function broadcast(data: unknown) {
  if (!wss) return;
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
