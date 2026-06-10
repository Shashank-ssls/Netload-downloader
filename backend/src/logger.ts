import path from 'path';
import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';
const logDir = path.resolve(process.env.LOG_PATH || './logs');
// Poor-man's rotation: one file per day. pino/file creates the dir (mkdir).
const logFile = path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`);

const logger = pino({
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
