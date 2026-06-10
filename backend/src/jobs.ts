import { Task, TaskStatus } from './types';

const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * Normalize a batch input (an array, or a pasted blob) into a clean, de-duped
 * list of http(s) URLs. Splits on whitespace/commas, trims, drops blanks,
 * `#` comments, and anything that isn't an http(s) URL.
 */
export function parseUrlList(input: string[] | string): string[] {
  const raw = Array.isArray(input) ? input : input.split(/[\s,]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const s = (item || '').trim();
    if (!s || s.startsWith('#')) continue;
    if (!/^https?:\/\//i.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export interface JobTaskView {
  id: string;
  url: string;
  title: string;
  status: TaskStatus;
  progress: number;
  error?: string;
  note?: string;
  path?: string;
}

export interface JobSummary {
  jobId: string;
  total: number;
  counts: Record<string, number>;
  done: boolean;
  tasks: JobTaskView[];
}

/** Roll a job's tasks into per-status counts + a done flag (all terminal). */
export function summarizeJob(jobId: string, tasks: Task[]): JobSummary {
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const done = tasks.length > 0 && tasks.every((t) => TERMINAL.includes(t.status));
  return {
    jobId,
    total: tasks.length,
    counts,
    done,
    tasks: tasks.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      status: t.status,
      progress: t.progress,
      error: t.error,
      note: t.note,
      path: t.path,
    })),
  };
}
