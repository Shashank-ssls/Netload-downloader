import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.join(__dirname, '../.env.local') });

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  env: process.env.NODE_ENV || 'development',
  databasePath: path.resolve(process.env.DATABASE_PATH || './database/downloader.db'),
  storagePath: path.resolve(process.env.STORAGE_PATH || 'F:/MediaDownloads'),
  tempPath: path.resolve(process.env.TEMP_PATH || './temp'),
  ffmpegPath: path.resolve(process.env.FFMPEG_PATH || './ffmpeg'),
  ytdlpPath: path.resolve(process.env.YTDLP_PATH || './yt-dlp/yt-dlp.exe'),
  cookiesPath: path.resolve(process.env.COOKIES_PATH || './cookies/cookies.txt'),
  nodePath: process.env.NODE_PATH || 'F:\\Apps\\NodeJS',
};

// Ensure required directories exist
const dirs = [
  path.dirname(config.databasePath),
  config.storagePath,
  config.tempPath,
  path.dirname(config.cookiesPath),
];

dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});
