import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { ZodError } from 'zod';
import { config } from './config';
import logger from './logger';
import { initWebSocket, setupTaskBroadcasts } from './progress';
import { tasks, closeDatabase } from './database';
import { analyzeUrl } from './analyzer';
import { QueueManager } from './queue';
import { DownloadRequestSchema, TaskStatusSchema, SettingsSchema } from './types';
import { FileValidator, CookieValidator } from './utils/validators';
import { YTDLPProcessManager } from './yt-dlp';
import { BrowserManager } from './utils/browserManager';

// Validate required binaries exist before accepting any traffic
const ffmpegExe = path.join(config.ffmpegPath, 'ffmpeg.exe');
if (!fs.existsSync(ffmpegExe)) {
  logger.error(`ffmpeg not found at ${ffmpegExe} — set FFMPEG_PATH in .env.local`);
  process.exit(1);
}
if (!fs.existsSync(config.ytdlpPath)) {
  logger.error(`yt-dlp not found at ${config.ytdlpPath} — set YTDLP_PATH in .env.local`);
  process.exit(1);
}

const app = express();
const server = createServer(app);

// Only accept connections from localhost
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      cb(null, true);
    } else {
      cb(new Error('CORS: origin not allowed'));
    }
  },
}));
app.use(express.json());

// Health Check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Analyze URL
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL required' });
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are supported' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const result = await analyzeUrl(url);
    res.json(result);
  } catch (err: any) {
    const status = err.message === 'NETWORK_TIMEOUT' ? 504 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Create Download Task
app.post('/api/download', async (req, res) => {
  try {
    const data = DownloadRequestSchema.parse(req.body);
    const { url, format, audioOnly } = data;
    const effectiveFormat = audioOnly ? 'bestaudio' : format;
    const taskId = await QueueManager.add(url, { title: 'Extracting...', format: effectiveFormat });
    res.json({ taskId });
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: err.flatten() });
    }
    res.status(400).json({ error: err.message });
  }
});

// Get All Tasks
app.get('/api/tasks', (_req, res) => {
  res.json(tasks.getAll());
});

// Get Task by ID
app.get('/api/tasks/:id', (req, res) => {
  const task = tasks.getById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

// Update Task Status
app.put('/api/tasks/:id/status', (req, res) => {
  const { status } = req.body;
  if (!TaskStatusSchema.safeParse(status).success) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  tasks.update(req.params.id, { status });
  res.json({ success: true });
});

// Cancel Task
app.post('/api/tasks/:id/cancel', (req, res) => {
  const task = tasks.getById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  YTDLPProcessManager.cancel(req.params.id);
  tasks.update(req.params.id, { status: 'cancelled' });
  res.json({ success: true });
});

// Delete Task
app.delete('/api/tasks/:id', (req, res) => {
  YTDLPProcessManager.cancel(req.params.id);
  tasks.delete(req.params.id);
  res.json({ success: true });
});

// Get Settings
app.get('/api/settings', (_req, res) => {
  const settingsPath = path.join(__dirname, '../config/settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      res.json(settings);
    } catch {
      res.status(500).json({ error: 'Failed to read settings' });
    }
  } else {
    res.status(404).json({ error: 'Settings not found' });
  }
});

// Update Settings
app.post('/api/settings', (req, res) => {
  const result = SettingsSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() });
  }
  const settingsPath = path.join(__dirname, '../config/settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(result.data, null, 2));
  if (result.data.maxConcurrentDownloads) {
    QueueManager.setMaxConcurrent(result.data.maxConcurrentDownloads);
  }
  res.json({ success: true });
});

// Cookies Status
app.get('/api/cookies/status', (_req, res) => {
  const exists = fs.existsSync(config.cookiesPath);
  const valid = CookieValidator.isValid(config.cookiesPath);
  res.json({ exists, valid, path: config.cookiesPath });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: err.message }, 'Unhandled route error');
  res.status(500).json({ error: 'Internal server error' });
});

// WebSocket
initWebSocket(server);
setupTaskBroadcasts();

// Startup recovery: reset any tasks left in-flight from a previous crash
const staleCount = tasks.resetStaleTasks();
if (staleCount > 0) {
  logger.info({ count: staleCount }, 'Reset stale in-progress tasks to queued');
}

// Apply saved maxConcurrentDownloads from settings
const settingsPath = path.join(__dirname, '../config/settings.json');
if (fs.existsSync(settingsPath)) {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (saved.maxConcurrentDownloads) QueueManager.setMaxConcurrent(saved.maxConcurrentDownloads);
  } catch { /* non-fatal */ }
}

// Resume any queued tasks
QueueManager.process();

// Hourly temp file cleanup
setInterval(() => {
  FileValidator.cleanupTemp(config.tempPath, 24);
}, 60 * 60 * 1000);

server.listen(config.port, '127.0.0.1', () => {
  logger.info(`NetLoad Downloader Backend running on 127.0.0.1:${config.port}`);
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down...`);
  server.close(() => logger.info('HTTP server closed'));
  YTDLPProcessManager.cancelAll();
  await BrowserManager.shutdown();
  closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
