import { randomUUID } from 'crypto';
import fs from 'fs';
import { YTDLPProcessManager } from './yt-dlp';
import { AnalysisResult } from './types';
import { config } from './config';
import logger from './logger';
import { ProviderDetector } from './providers/detector';
import { HeaderBuilder } from './utils/headers';
import { CloudflareRecoveryManager } from './recovery/cloudflare';
import { UARotator } from './utils/userAgents';
import { FallbackExtractor, DURATION_FLOOR_SEC } from './extractors/fallbackExtractor';
import { CookieValidator } from './utils/validators';

export async function analyzeUrl(url: string): Promise<AnalysisResult> {
  const timeoutMs = 35000;
  const provider = ProviderDetector.detect(url);
  const maxRetries = CloudflareRecoveryManager.MAX_RETRIES;
  let attempt = 0;
  let targetUrl = url;
  let capturedHeaders: Record<string, string> = {};
  let capturedUA: string | null = null;
  let usedFallback = false;
  let fallbackPreview = false;
  let sawAuthRequired = false;

  while (attempt < maxRetries) {
    attempt++;
    let stderrOutput = '';
    const spawnId = randomUUID();

    try {
      const baseHeaders = (targetUrl === url) ? HeaderBuilder.getHeadersForProvider(provider.name, targetUrl) : {};
      const ua = capturedUA || (attempt > 1 ? UARotator.getNext() : UARotator.getDesktop());
      const mergedHeaders = { ...baseHeaders, ...capturedHeaders };
      const headerArgs = HeaderBuilder.formatForYTDLP(mergedHeaders, ua);

      const specificArgs = provider.getSpecificArgs(targetUrl);
      const args = ['-J', '--no-playlist', targetUrl, ...headerArgs, ...specificArgs];

      const impersonate = provider.getImpersonateTarget();
      if (impersonate) args.push('--impersonate', impersonate);
      if (attempt > 1) args.push(...CloudflareRecoveryManager.getRecoveryArgs(attempt));

      if (targetUrl !== url && (targetUrl.includes('.m3u8') || targetUrl.includes('/hls/'))) {
        args.push('--hls-prefer-native', '--hls-use-mpegts');
      }

      const analysisPromise = YTDLPProcessManager.spawn(spawnId, {
        args,
        captureStdout: true,
        onStderr: (data) => { stderrOutput += data; },
      });

      // Suppress unhandled rejection if the timeout race wins first
      analysisPromise.catch(() => {});

      let timeoutId: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('NETWORK_TIMEOUT')), timeoutMs);
      });

      const result = await Promise.race([analysisPromise, timeoutPromise]) as { code: number; stdout: string };
      clearTimeout(timeoutId!);

      const info = JSON.parse(result.stdout);
      const duration: number = info.duration || 0;

      const cookiesPresent = fs.existsSync(config.cookiesPath);
      const cookiesValid = CookieValidator.isValid(config.cookiesPath);

      // A short clip reached only via fallback extraction is almost certainly a
      // gated preview — the full content needs login cookies.
      const isLikelyPreview =
        fallbackPreview || (usedFallback && duration > 0 && duration < DURATION_FLOOR_SEC);
      const requiresAuth = sawAuthRequired || (isLikelyPreview && !cookiesValid);

      const warnings: string[] = [];
      if (isLikelyPreview) {
        warnings.push('This looks like a short preview — the full video may require login. Add a cookies.txt to download the complete version.');
      }
      if (requiresAuth && !cookiesPresent) {
        warnings.push('No cookies.txt found — log in to the site and export cookies to access gated content.');
      }
      if (cookiesPresent && !cookiesValid) {
        warnings.push('cookies.txt is present but not in valid Netscape format.');
      }

      return {
        title: info.title,
        duration,
        thumbnail: info.thumbnail,
        uploader: info.uploader,
        extractor: info.extractor,
        formats: info.formats,
        filesize: info.filesize || 0,
        vcodec: info.vcodec || 'none',
        acodec: info.acodec || 'none',
        cookiesPresent,
        cookiesValid,
        requiresAuth,
        isLikelyPreview,
        warnings,
      };

    } catch (err: any) {
      YTDLPProcessManager.cancel(spawnId);
      const errorType = provider.classifyError(stderrOutput) || YTDLPProcessManager.classifyError(stderrOutput);
      logger.error({ url: targetUrl, attempt, errorType }, 'Analysis attempt failed');

      if (errorType === 'AUTH_REQUIRED') sawAuthRequired = true;

      if (errorType === 'CLOUDFLARE_BLOCKED' && attempt < maxRetries) {
        logger.info({ url: targetUrl }, 'Analysis hit CF block — harvesting clearance...');
        const tokens = await CloudflareRecoveryManager.harvestClearance(targetUrl);
        if (tokens) {
          capturedHeaders['Cookie'] = `cf_clearance=${tokens.cfClearance}`;
          capturedUA = tokens.userAgent;
          await CloudflareRecoveryManager.waitCooldown(attempt);
          continue;
        }
      }

      if ((CloudflareRecoveryManager.isRecoverable(errorType) || errorType === 'UNSUPPORTED_URL' || errorType === 'DYNAMIC_CONTENT_UNSUPPORTED') && attempt < maxRetries) {
        logger.info({ url: targetUrl, errorType }, 'Analysis trying fallback extraction...');
        const captured = await FallbackExtractor.extractMediaUrl(targetUrl, provider.name);
        if (captured) {
          targetUrl = captured.url;
          capturedHeaders = captured.headers;
          capturedUA = captured.userAgent;
          usedFallback = true;
          if (captured.isLikelyPreview) fallbackPreview = true;
          logger.info({ fallbackUrl: targetUrl, isLikelyPreview: captured.isLikelyPreview }, 'Fallback URL found — retrying analysis');
          continue;
        }
        await CloudflareRecoveryManager.waitCooldown(attempt);
        continue;
      }

      if (err.message === 'NETWORK_TIMEOUT') throw err;
      throw new Error(errorType);
    }
  }

  throw new Error('MAX_RETRIES_EXCEEDED');
}
