import { randomUUID } from 'crypto';
import { tasks } from './database';
import { downloadMedia } from './downloader';
import logger from './logger';

export class QueueManager {
  private static maxConcurrent = 3;
  private static activeCount = 0;

  static async add(url: string, options: { title: string; format?: string }) {
    const id = randomUUID();
    tasks.create({
      id,
      url,
      title: options.title,
      format: options.format,
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

      downloadMedia(task.id, () => {})
        .catch(err => {
          logger.error({ taskId: task.id, err }, 'Task failed in queue');
        })
        .finally(() => {
          this.activeCount--;
          this.process();
        });
    }
  }

  static setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, Math.min(20, n));
  }
}
