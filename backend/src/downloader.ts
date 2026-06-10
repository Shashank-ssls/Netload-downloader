import { YTDLPProcessManager } from './yt-dlp';
import { tasks } from './database';
import { config } from './config';
import { ProgressData, Task, CapturedStream } from './types';
import logger from './logger';
import path from 'path';
import { ProviderDetector } from './providers/detector';
import { HeaderBuilder } from './utils/headers';
import { FallbackExtractor, DURATION_FLOOR_SEC, BYTES_FLOOR } from './extractors/fallbackExtractor';
import { SegmentStitcher } from './extractors/segmentStitcher';
import { CloudflareRecoveryManager } from './recovery/cloudflare';
import { FileValidator } from './utils/validators';
import { UARotator } from './utils/userAgents';

// Patterns that indicate the target URL is a direct media stream
const DIRECT_STREAM_PATTERNS = [
  /\.m3u8(\?|$)/i,
  /\.mp4(\?|$)/i,
  /\/hls\//i,
  /\/dash\//i,
  /master\.m3u8/i,
  /index\.m3u8/i,
  /playlist\.m3u8/i,
];

function isDirectStream(url: string): boolean {
  return DIRECT_STREAM_PATTERNS.some(p => p.test(url));
}

export async function downloadMedia(taskId: string, onProgress: (data: ProgressData) => void): Promise<string> {
  const task = tasks.getById(taskId);
  if (!task) throw new Error('TASK_NOT_FOUND');

  const provider = ProviderDetector.detect(task.url);
  const maxRetries = CloudflareRecoveryManager.MAX_RETRIES;
  let attempt = 0;
  let targetUrl = task.url;
  let capturedHeaders: Record<string, string> = {};
  let capturedUA: string | null = null;
  let isFallbackStream = false;

  // Ranked fallback candidates (filled lazily on first recovery). We advance
  // through them when a candidate fails to download; a candidate that downloads
  // but is too small is treated as the best-available preview (not retried,
  // since candidates are already ranked by size).
  let candidates: CapturedStream[] = [];
  let candIdx = -1;

  while (attempt < maxRetries) {
    attempt++;
    let stderrOutput = '';
    let discoveredPath = '';

    const args = [targetUrl];

    // Format / audio-only strategy
    if (task.format === 'bestaudio') {
      args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3');
    } else if (isFallbackStream) {
      args.push('-f', 'best');
    } else if (task.format) {
      args.push('-f', task.format);
    } else {
      args.push('-f', provider.getFormatStrategy());
    }

    // Output path
    args.push('-o', path.join(config.storagePath, '%(title)s.%(ext)s'));

    // Metadata capture via --print (fires before download starts)
    args.push('--print', 'before_dl:%(title)s\t%(uploader)s\t%(thumbnail)s');
    // Reliable final path after merge / post-processing
    args.push('--print', 'after_move:%(filepath)s');

    // Headers
    const baseHeaders = isFallbackStream ? {} : HeaderBuilder.getHeadersForProvider(provider.name, targetUrl);
    const mergedHeaders = { ...baseHeaders, ...capturedHeaders };
    const ua = capturedUA || (attempt > 1 ? UARotator.getNext() : UARotator.getDesktop());
    args.push(...HeaderBuilder.formatForYTDLP(mergedHeaders, ua));

    // Provider-specific args
    args.push(...provider.getSpecificArgs(targetUrl));

    // Impersonation
    const impersonate = provider.getImpersonateTarget();
    if (impersonate) args.push('--impersonate', impersonate);

    // HLS mode for direct streams
    if (isFallbackStream || targetUrl.includes('.m3u8')) {
      args.push('--hls-prefer-native', '--hls-use-mpegts');
    }

    // Recovery args on retries (only when not using CF-captured UA)
    if (attempt > 1 && !capturedUA) {
      args.push(...CloudflareRecoveryManager.getRecoveryArgs(attempt));
    }

    try {
      tasks.update(taskId, { status: 'downloading' });

      await YTDLPProcessManager.spawn(taskId, {
        args,
        onProgress: (data) => {
          tasks.update(taskId, {
            progress: data.progress,
            filesize: data.size,
            speed: data.speed,
            eta: data.eta,
          });
          onProgress(data);
        },
        onStderr: (data) => { stderrOutput += data; },
        onPathDiscovered: (parsedPath) => {
          discoveredPath = parsedPath;
          tasks.update(taskId, { path: parsedPath });
        },
        onMetadata: (meta) => {
          const updates: Partial<Task> = {};
          if (meta.title && meta.title !== 'NA') updates.title = meta.title;
          if (meta.uploader && meta.uploader !== 'NA') updates.uploader = meta.uploader;
          if (meta.thumbnail && meta.thumbnail !== 'NA' && meta.thumbnail.startsWith('http')) {
            updates.thumbnail = meta.thumbnail;
          }
          if (Object.keys(updates).length > 0) tasks.update(taskId, updates);
        },
      });

      const finalPath = discoveredPath || tasks.getById(taskId)?.path;

      // Size sanity-check for fallback candidates. Because candidates are already
      // ranked by probed size, the one we picked is the largest available — so a
      // small result means the best we can get anonymously is a preview/placeholder.
      // Keep it (don't chase the smaller, lower-ranked candidates — those are the
      // ads/teasers) and flag it so the user knows to add login cookies.
      const usingFallback = candIdx >= 0;
      if (usingFallback && finalPath &&
          !FileValidator.isContentSane(finalPath, { minBytes: BYTES_FLOOR, minDurationSec: DURATION_FLOOR_SEC })) {
        logger.info({ taskId, finalPath }, 'Best fallback candidate is a preview/placeholder — flagging for cookies');
        tasks.update(taskId, { status: 'completed', progress: 100, note: 'LIKELY_PREVIEW_ADD_COOKIES' });
        return 'SUCCESS';
      }

      if (finalPath) FileValidator.validate(finalPath);
      tasks.update(taskId, { status: 'completed', progress: 100, note: '' });
      return 'SUCCESS';

    } catch (err) {
      const errorType = provider.classifyError(stderrOutput) || YTDLPProcessManager.classifyError(stderrOutput);
      logger.error({ taskId, attempt, errorType }, 'Download execution failed');

      if (CloudflareRecoveryManager.isRecoverable(errorType) && attempt < maxRetries) {
        logger.info({ taskId, errorType }, 'Attempting CF clearance + fallback for download...');

        if (errorType === 'CLOUDFLARE_BLOCKED') {
          const tokens = await CloudflareRecoveryManager.harvestClearance(targetUrl);
          if (tokens) {
            capturedHeaders['Cookie'] = `cf_clearance=${tokens.cfClearance}`;
            capturedUA = tokens.userAgent;
            logger.info({ taskId }, 'CF clearance injected — retrying download');
            await CloudflareRecoveryManager.waitCooldown(attempt);
            continue;
          }
        }

        // Tier 1 + Tier 2 fallback — always from original URL. Fetched once and
        // ranked by size; we advance to the next source each time one fails to
        // download (a download error, not a small file).
        if (candidates.length === 0) {
          candidates = await FallbackExtractor.extractRankedCandidates(task.url, provider.name);

          // Segmented stream: the site serves many short sibling chunks and no
          // single full-episode URL. Capture them all and stitch with ffmpeg.
          const segPrefix = SegmentStitcher.looksLikeSegmentRun(candidates);
          if (segPrefix) {
            logger.info({ taskId, segPrefix }, 'Segmented stream detected — capturing + stitching segments');
            tasks.update(taskId, { status: 'downloading', progress: 0 });
            try {
              const outPath = path.join(config.storagePath, `${taskId}.mp4`);
              const stitched = await SegmentStitcher.run(task.url, segPrefix, outPath, (data) => {
                tasks.update(taskId, { progress: data.progress, filesize: data.size, speed: data.speed, eta: data.eta });
                onProgress(data);
              });
              if (stitched && FileValidator.isContentSane(stitched.path, { minBytes: BYTES_FLOOR, minDurationSec: DURATION_FLOOR_SEC })) {
                FileValidator.validate(stitched.path);
                tasks.update(taskId, {
                  status: 'completed', progress: 100, path: stitched.path,
                  note: stitched.partial ? 'PARTIAL_CAPTURE' : '',
                });
                return 'SUCCESS';
              }
              logger.warn({ taskId, stitched }, 'Stitched output missing/too small — falling back to candidate walk');
            } catch (e: any) {
              logger.error({ taskId, err: e.message }, 'Segment stitching failed — falling back to candidate walk');
            }
          }
        }
        candIdx++;
        if (candIdx < candidates.length) {
          const c = candidates[candIdx];
          targetUrl = c.url;
          capturedHeaders = c.headers;
          capturedUA = c.userAgent;
          isFallbackStream = isDirectStream(c.url);
          logger.info({ taskId, candIdx, fallbackUrl: targetUrl, candidateCount: candidates.length }, 'Trying fallback candidate');
          await CloudflareRecoveryManager.waitCooldown(attempt);
          continue;
        }

        logger.info({ taskId, candidateCount: candidates.length }, 'All fallback candidates exhausted');
        await CloudflareRecoveryManager.waitCooldown(attempt);
        continue;
      }

      tasks.update(taskId, { status: 'failed', error: errorType });
      throw new Error(errorType);
    }
  }

  tasks.update(taskId, { status: 'failed', error: 'MAX_RETRIES_EXCEEDED' });
  throw new Error('MAX_RETRIES_EXCEEDED');
}
