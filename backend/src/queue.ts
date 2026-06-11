import { randomUUID } from 'crypto';
import { tasks } from './database';
import { downloadMedia } from './downloader';
import { ProviderDetector } from './providers/detector';
import { Metrics } from './utils/metrics';
import { HostThrottle } from './utils/hostThrottle';
import type { Task } from './types';
import logger from './logger';

export class QueueManager {
  private static maxConcurrent = 3;
  private static activeCount = 0;

  static async add(url: string, options: { title: string; format?: string; options?: string; jobId?: string }) {
    const id = randomUUID();
    tasks.create({
      id,
      url,
      title: options.title,
      format: options.format,
      options: options.options,
      jobId: options.jobId,
      status: 'queued',
    });
    this.process();
    return id;
  }

  static process() {
    while (this.activeCount < this.maxConcurrent) {
      const task = tasks.claimNext();
      if (!task) break;

      this.activeCount++;
      logger.info({ taskId: task.id, format: task.format }, 'Starting task from queue');

      // Per-host politeness cap (HostThrottle) + per-provider outcome metrics.
      const host = HostThrottle.hostOf(task.url);
      HostThrottle.run(host, () => downloadMedia(task.id, () => {}))
        .catch(err => {
          logger.error({ taskId: task.id, err }, 'Task failed in queue');
        })
        .finally(() => {
          this.recordOutcome(task);
          this.activeCount--;
          this.process();
        });
    }
  }

  /** Record the final outcome (per provider) once a task settles. Centralised here
   *  rather than scattered across the downloader's many exit points. */
  private static recordOutcome(task: Task): void {
    const final = tasks.getById(task.id);
    if (!final) return;
    const provider = ProviderDetector.detect(task.url).name;
    if (final.status === 'completed') Metrics.recordSuccess(provider);
    else if (final.status === 'failed') Metrics.recordFailure(provider, final.error || 'UNKNOWN_ERROR');
    // paused / cancelled / still-queued → not a terminal outcome; don't count.
  }

  static setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, Math.min(20, n));
  }

  static getStats() {
    return { active: this.activeCount, maxConcurrent: this.maxConcurrent };
  }
}
