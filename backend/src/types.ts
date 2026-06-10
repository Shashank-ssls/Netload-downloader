import { z } from 'zod';
import path from 'path';

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
  options?: string; // JSON-encoded DownloadOptions
  jobId?: string;   // groups tasks created by one /api/batch call
  createdAt: number;
  updatedAt: number;
}

/** Per-download options persisted on the task and applied as yt-dlp args. */
export interface DownloadOptions {
  formatId?: string;
  subtitles?: boolean;
  embedThumbnail?: boolean;
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

/** A single downloadable format from yt-dlp's `-J` output (loosely typed —
 *  yt-dlp emits many optional/extra fields per extractor). */
export interface MediaFormat {
  format_id?: string;
  ext?: string;
  height?: number | null;
  width?: number | null;
  resolution?: string;
  vcodec?: string;
  acodec?: string;
  filesize?: number | null;
  filesize_approx?: number | null;
  url?: string;
  [key: string]: unknown;
}

export interface AnalysisResult {
  title: string;
  duration: number;
  thumbnail: string;
  uploader: string;
  extractor: string;
  formats: MediaFormat[];
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
  playlist: z.boolean().optional().default(false),
  formatId: z.string().optional(),
  subtitles: z.boolean().optional().default(false),
  embedThumbnail: z.boolean().optional().default(false),
});

export type DownloadRequest = z.infer<typeof DownloadRequestSchema>;

export const BatchRequestSchema = z.object({
  urls: z.union([z.array(z.string()), z.string()]),
  format: z.string().optional(),
  audioOnly: z.boolean().optional().default(false),
  playlist: z.boolean().optional().default(false),
  formatId: z.string().optional(),
  subtitles: z.boolean().optional().default(false),
  embedThumbnail: z.boolean().optional().default(false),
});

export type BatchRequest = z.infer<typeof BatchRequestSchema>;

export const SettingsSchema = z.object({
  downloadDir: z
    .string()
    .min(1)
    .refine((v) => path.isAbsolute(v) && !v.includes('..'), {
      message: 'downloadDir must be an absolute path without ".."',
    }),
  maxConcurrentDownloads: z.number().int().min(1).max(20).optional().default(3),
  cookiesPath: z.string().optional(),
  ffmpegPath: z.string().optional(),
  ytdlpPath: z.string().optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;
