import { z } from 'zod';

export const TaskStatusSchema = z.enum([
  'queued',
  'extracting',
  'downloading',
  'processing',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export interface Task {
  id: string;
  url: string;
  title: string;
  status: TaskStatus;
  progress: number;
  speed: string;
  eta: string;
  filesize: string;
  thumbnail?: string;
  uploader?: string;
  format?: string;
  path?: string;
  error?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProgressData {
  progress: number;
  size: string;
  speed: string;
  eta: string;
}

export interface MetadataInfo {
  title: string;
  uploader: string;
  thumbnail: string;
}

export interface AnalysisResult {
  title: string;
  duration: number;
  thumbnail: string;
  uploader: string;
  extractor: string;
  formats: any[];
  filesize: number;
  vcodec: string;
  acodec: string;
  cookiesPresent: boolean;
  cookiesValid: boolean;
  requiresAuth?: boolean;
  isLikelyPreview?: boolean;
  warnings: string[];
}

/** Cheap pre-download size signal used to rank candidate streams. */
export interface StreamMagnitude {
  durationSec?: number;
  bytes?: number;
  isManifest: boolean;
}

export interface CapturedStream {
  url: string;
  referer: string;
  userAgent: string;
  headers: Record<string, string>;
  magnitude?: StreamMagnitude;
  isLikelyPreview?: boolean;
}

export const DownloadRequestSchema = z.object({
  url: z.string().url(),
  format: z.string().optional(),
  audioOnly: z.boolean().optional().default(false),
});

export type DownloadRequest = z.infer<typeof DownloadRequestSchema>;

export const SettingsSchema = z.object({
  downloadDir: z.string().min(1),
  maxConcurrentDownloads: z.number().int().min(1).max(20).optional().default(3),
  cookiesPath: z.string().optional(),
  ffmpegPath: z.string().optional(),
  ytdlpPath: z.string().optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;
