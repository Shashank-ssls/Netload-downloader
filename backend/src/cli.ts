#!/usr/bin/env node
/**
 * netload — thin CLI over the running backend API.
 *
 *   netload <url> [--audio] [--format <id>] [--playlist] [--subs] [--thumb]
 *   netload batch <file>       download every URL in a file as one job
 *   netload corpus [path]      measure reach across a URL corpus (analyze only)
 *
 * Requires the backend to be running (npm run dev / start). Set NETLOAD_API to
 * point at a non-default host (default http://127.0.0.1:4000).
 */

import fs from 'fs';
import path from 'path';
import { classifyOutcome, matchesExpect, Outcome } from './corpus/classify';

const API = process.env.NETLOAD_API || 'http://127.0.0.1:4000';

interface TaskView {
  status: string;
  progress?: number;
  title?: string;
  path?: string;
  note?: string;
  error?: string;
}

function printHelp(): void {
  console.log(`netload <url> [options]
netload batch <file>    download every URL in a file (one per line) as one job
netload corpus [path]   measure reach across a URL corpus (analyze only)
netload diagnose <url>  inspect a (new/failing) site and report why it does/doesn't work

  --audio          audio only (mp3)
  --format <id>    specific format id (from analyze)
  --playlist       expand a playlist/channel into individual downloads
  --subs           download + embed English subtitles
  --thumb          embed thumbnail
  -h, --help       show this help

Env: NETLOAD_API (default ${API})`);
}

async function pollTask(id: string): Promise<void> {
  let last = '';
  for (;;) {
    const t = (await (await fetch(`${API}/api/tasks/${id}`)).json()) as TaskView;
    const pct = typeof t.progress === 'number' ? t.progress.toFixed(1) : '0';
    const line = `${id.slice(0, 8)}  ${t.status.padEnd(11)} ${pct.padStart(5)}%  ${t.title ?? ''}`;
    if (line !== last) {
      console.log(line);
      last = line;
    }
    if (['completed', 'failed', 'cancelled'].includes(t.status)) {
      if (t.status === 'completed') console.log(`  -> ${t.path}${t.note ? `  [${t.note}]` : ''}`);
      if (t.status === 'failed') console.log(`  -> error: ${t.error}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

interface CorpusEntry {
  name: string;
  url: string;
  category?: string;
  expect?: string;
  note?: string;
}

/** Analyze one URL and reduce it to a coarse outcome string. */
async function analyzeOutcome(url: string): Promise<Outcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const resp = await fetch(`${API}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const b = (await resp.json().catch(() => ({}))) as { error?: string };
      return `error:${b.error || resp.status}`;
    }
    return classifyOutcome((await resp.json()) as Record<string, unknown>);
  } catch (e: any) {
    return `error:${e?.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE'}`;
  } finally {
    clearTimeout(timer);
  }
}

async function runCorpus(args: string[]): Promise<void> {
  // Fail fast if the backend isn't up (otherwise every entry just times out).
  try {
    await fetch(`${API}/api/health`);
  } catch {
    console.error(`error: cannot reach backend at ${API} — start it (npm run dev) first`);
    process.exit(1);
  }

  // Prefer the user's private (gitignored) corpus/urls.json; fall back to the
  // committed corpus/urls.example.json so a fresh clone still runs.
  let file = args[0] ? path.resolve(args[0]) : '';
  if (!file) {
    const local = path.resolve('corpus/urls.json');
    file = fs.existsSync(local) ? local : path.resolve('corpus/urls.example.json');
  }
  let entries: CorpusEntry[];
  try {
    entries = (JSON.parse(fs.readFileSync(file, 'utf8')).entries || []) as CorpusEntry[];
  } catch {
    console.error(`error: cannot read corpus at ${file}`);
    process.exit(1);
  }
  console.log(`(using ${path.basename(file)})`);

  console.log(`Reach corpus — ${entries.length} entries via ${API}\n`);
  console.log(`  RESULT  ${'NAME'.padEnd(30)}${'CATEGORY'.padEnd(12)}${'EXPECT'.padEnd(10)}ACTUAL`);
  let pass = 0;
  const failed: string[] = [];
  for (const e of entries) {
    const actual = await analyzeOutcome(e.url);
    const ok = matchesExpect(e.expect, actual);
    if (ok) pass++;
    else failed.push(e.name);
    console.log(
      `  ${(ok ? 'PASS' : 'FAIL').padEnd(6)}  ${(e.name || '').slice(0, 28).padEnd(30)}` +
        `${(e.category || '').padEnd(12)}${(e.expect || 'resolve').padEnd(10)}${actual}`,
    );
  }
  console.log(`\n${pass}/${entries.length} passed`);
  if (failed.length) {
    console.log(`FAILED: ${failed.join(', ')}`);
    process.exit(1);
  }
}

interface JobView {
  done: boolean;
  total: number;
  counts: Record<string, number>;
  tasks: { title?: string; url: string; status: string; error?: string; note?: string; path?: string }[];
}

async function runBatch(args: string[]): Promise<void> {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) {
    console.error('usage: netload batch <file> [--audio] [--format <id>] [--playlist] [--subs] [--thumb]');
    process.exit(1);
  }
  let urls: string[];
  try {
    urls = fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/);
  } catch {
    console.error(`error: cannot read ${file}`);
    process.exit(1);
  }

  const body: Record<string, unknown> = {
    urls,
    audioOnly: args.includes('--audio'),
    playlist: args.includes('--playlist'),
    subtitles: args.includes('--subs'),
    embedThumbnail: args.includes('--thumb'),
  };
  const fIdx = args.indexOf('--format');
  if (fIdx >= 0 && args[fIdx + 1]) body.formatId = args[fIdx + 1];

  let resp: Response;
  try {
    resp = await fetch(`${API}/api/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    console.error(`error: cannot reach backend at ${API} — is it running?`);
    process.exit(1);
  }
  if (!resp.ok) {
    console.error(`error: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }

  const { jobId, count } = (await resp.json()) as { jobId: string; count: number };
  console.log(`job ${jobId.slice(0, 8)} — ${count} task(s) queued`);

  for (;;) {
    const j = (await (await fetch(`${API}/api/jobs/${jobId}`)).json()) as JobView;
    const summary = Object.entries(j.counts).map(([k, v]) => `${k}:${v}`).join('  ');
    process.stdout.write(`\r  ${summary.padEnd(64)}`);
    if (j.done) {
      process.stdout.write('\n\n');
      for (const t of j.tasks) {
        const mark = t.status === 'completed' ? 'OK ' : t.status === 'failed' ? 'ERR' : t.status.slice(0, 3).toUpperCase();
        const detail =
          t.status === 'completed' ? `${t.path ?? ''}${t.note ? `  [${t.note}]` : ''}` : t.error || t.status;
        // Show the URL when the title never resolved (e.g. a task that failed early).
        const label = t.title && t.title !== 'Extracting...' ? t.title : t.url;
        console.log(`  ${mark}  ${label.slice(0, 48).padEnd(48)} ${detail}`);
      }
      const ok = j.counts.completed || 0;
      const failed = j.counts.failed || 0;
      console.log(`\n${ok} completed, ${failed} failed, ${j.total} total`);
      if (failed > 0) process.exit(1);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

interface DiagReportView {
  url: string;
  finalUrl: string;
  durationMs: number;
  totalRequests: number;
  byResourceType: Record<string, number>;
  mediaRequests: { url: string; resourceType: string; contentType?: string; mediaKind?: string; status?: number }[];
  page: {
    videos: { src: string; currentSrc: string; usesBlob: boolean }[];
    playerGlobals: string[];
    mediaSourceUsed: boolean;
    appendBufferCount: number;
    sourceBufferMimes: string[];
    blobUrlCount: number;
    iframeChain: string[];
  };
  hints: string[];
}

async function runDiagnose(args: string[]): Promise<void> {
  const url = args.find((a) => !a.startsWith('-'));
  if (!url) {
    console.error('usage: netload diagnose <url>');
    process.exit(1);
  }
  const json = args.includes('--json');

  let resp: Response;
  try {
    resp = await fetch(`${API}/api/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch {
    console.error(`error: cannot reach backend at ${API} — is it running?`);
    process.exit(1);
  }
  if (!resp.ok) {
    console.error(`error: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const r = (await resp.json()) as DiagReportView;

  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  console.log(`\nDiagnose: ${r.url}`);
  if (r.finalUrl && r.finalUrl !== r.url) console.log(`  final URL: ${r.finalUrl}`);
  const byType = Object.entries(r.byResourceType).map(([k, v]) => `${k}:${v}`).join('  ');
  console.log(`  ${r.totalRequests} requests in ${(r.durationMs / 1000).toFixed(1)}s  [${byType}]`);

  console.log(`\n  Media responses (${r.mediaRequests.length}):`);
  if (r.mediaRequests.length === 0) console.log('    (none seen on the network)');
  for (const m of r.mediaRequests.slice(0, 20)) {
    console.log(`    [${m.mediaKind}] ${m.status ?? ''} ${m.contentType ?? ''}\n      ${m.url.slice(0, 110)}`);
  }

  const p = r.page;
  console.log(`\n  Player: globals=[${p.playerGlobals.join(', ') || 'none'}]  MSE=${p.mediaSourceUsed}  appendBuffer=${p.appendBufferCount}  blobURLs=${p.blobUrlCount}`);
  if (p.sourceBufferMimes.length) console.log(`    SourceBuffer mimes: ${p.sourceBufferMimes.join(', ')}`);
  for (const v of p.videos) console.log(`    <video> src=${(v.currentSrc || v.src || '(none)').slice(0, 90)}${v.usesBlob ? '  [blob:]' : ''}`);
  if (p.iframeChain.length) console.log(`    iframes: ${p.iframeChain.length}`);

  console.log(`\n  Hints:`);
  if (r.hints.length === 0) console.log('    (no specific hints)');
  for (const h of r.hints) console.log(`    - ${h}`);
  console.log('');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'batch') {
    await runBatch(argv.slice(1));
    return;
  }
  if (argv[0] === 'corpus') {
    await runCorpus(argv.slice(1));
    return;
  }
  if (argv[0] === 'diagnose') {
    await runDiagnose(argv.slice(1));
    return;
  }
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return;
  }

  const url = argv.find((a) => !a.startsWith('-'));
  if (!url) {
    console.error('error: no URL provided');
    process.exit(1);
  }

  const body: Record<string, unknown> = {
    url,
    audioOnly: argv.includes('--audio'),
    playlist: argv.includes('--playlist'),
    subtitles: argv.includes('--subs'),
    embedThumbnail: argv.includes('--thumb'),
  };
  const fIdx = argv.indexOf('--format');
  if (fIdx >= 0 && argv[fIdx + 1]) body.formatId = argv[fIdx + 1];

  let resp: Response;
  try {
    resp = await fetch(`${API}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    console.error(`error: cannot reach backend at ${API} — is it running?`);
    process.exit(1);
  }

  if (!resp.ok) {
    console.error(`error: request failed (${resp.status}): ${await resp.text()}`);
    process.exit(1);
  }

  const data = (await resp.json()) as { taskId?: string; taskIds?: string[] };
  const ids = data.taskIds ?? (data.taskId ? [data.taskId] : []);
  console.log(`queued ${ids.length} task(s)`);
  await Promise.all(ids.map(pollTask));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
