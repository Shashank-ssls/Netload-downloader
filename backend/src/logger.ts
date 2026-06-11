import path from 'path';
import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';
const logDir = path.resolve(process.env.LOG_PATH || './logs');
// Poor-man's rotation: one file per day. pino/file creates the dir (mkdir).
const logFile = path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`);

// pino transports run in worker threads that load the transport module by path at
// runtime — that can't be bundled into a single packaged executable. When running as
// a packaged exe, fall back to a plain stdout logger (no worker threads).
const packaged = !!(process as { pkg?: unknown }).pkg || !!(process as { isSEA?: unknown }).isSEA;

const logger = packaged
  ? pino({ level })
  : pino({
      level,
      transport: {
        targets: [
          {
            target: 'pino-pretty',
            level,
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
          {
            target: 'pino/file',
            level,
            options: { destination: logFile, mkdir: true },
          },
        ],
      },
    });

export default logger;
