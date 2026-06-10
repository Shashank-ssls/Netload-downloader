import { describe, it, expect } from 'vitest';
import { parseUrlList, summarizeJob } from '../src/jobs';
import type { Task } from '../src/types';

const task = (id: string, status: Task['status']): Task =>
  ({ id, url: `https://x.test/${id}`, title: id, status, progress: 0, speed: '', eta: '', filesize: '', createdAt: 0, updatedAt: 0 }) as Task;

describe('parseUrlList', () => {
  it('splits a pasted blob on whitespace/commas and keeps only http(s)', () => {
    const out = parseUrlList('https://a.test/1\nhttps://b.test/2 , https://c.test/3\n\nnot-a-url');
    expect(out).toEqual(['https://a.test/1', 'https://b.test/2', 'https://c.test/3']);
  });

  it('accepts an array, trims, drops comments + blanks, de-dupes', () => {
    const out = parseUrlList(['  https://a.test/1 ', '# comment', '', 'https://a.test/1', 'ftp://x']);
    expect(out).toEqual(['https://a.test/1']);
  });
});

describe('summarizeJob', () => {
  it('counts by status and is done only when all are terminal', () => {
    const s = summarizeJob('job1', [task('a', 'completed'), task('b', 'failed'), task('c', 'downloading')]);
    expect(s.total).toBe(3);
    expect(s.counts).toEqual({ completed: 1, failed: 1, downloading: 1 });
    expect(s.done).toBe(false);
  });

  it('is done when every task is terminal (completed/failed/cancelled)', () => {
    const s = summarizeJob('job2', [task('a', 'completed'), task('b', 'failed'), task('c', 'cancelled')]);
    expect(s.done).toBe(true);
  });

  it('a paused task is NOT terminal', () => {
    expect(summarizeJob('job3', [task('a', 'completed'), task('b', 'paused')]).done).toBe(false);
  });
});
