#!/usr/bin/env node
/**
 * netload — thin CLI over the running backend API.
 *
 *   netload <url> [--audio] [--format <id>] [--playlist] [--subs] [--thumb]
 *   netload batch <file>       download every URL in a file as one job
 *   netload corpus [path]      measure reach across a URL corpus (analyze only)
 *   netload onboard <url>      scaffold a site rule + corpus fixture for a new site
 *   netload login <url>        sign in / clear a challenge once; saves the session
 *   netload sessions           list saved logins; netload logout <host> to remove
 *
 * Requires the backend to be running (npm run dev / start). Set NETLOAD_API to
 * point at a non-default host (default http://127.0.0.1:4000).
 */

import fs from 'fs';
import path from 'path';
import {
  Outcome, Expectation,
  evaluateExpectation, summarizeByCategory, diffRuns,
} from './corpus/classify';
import { suggestOnboarding, type DiagLike, type AnalyzeLike, type CorpusFixture } from './corpus/onboard';
import type { SiteRule } from './providers/siteRules';
import { suggestRemedy } from './utils/remedy';

const API = process.env.NETLOAD_API || 'http://127.0.0.1:4000';

interface TaskView {
  status: string;
  progress?: number;
  title?: string;
  path?: string;
  note?: string;
  error?: string;
  url?: string;
}

function printHelp(): void {
  console.log(`netload <url> [options]
netload batch <file>    download every URL in a file (one per line) as one job
netload corpus [path]   measure reach across a URL corpus (analyze only)
netload diagnose <url>  inspect a (new/failing) site and report why it does/doesn't work
netload onboard <url>   diagnose+analyze a new site, then scaffold a site rule + corpus fixture
                          --name "Label"   fixture/rule label    --write   append to local files
netload login <url>     open a visible browser to sign in / solve a challenge once; saves the session
netload sessions        list saved per-site logins (host, cookies, age)
netload logout <host>   delete a saved login for a host

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
      const remedy = suggestRemedy(t);
      if (remedy) console.log(`  -> ${remedy}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

interface CorpusEntry {
  name: string;
  url: string;
  category?: string;
  expect?: string | Expectation;
  note?: string;
}

type AnalyzeResult = { duration?: number; extractor?: string; isLikelyPreview?: boolean; requiresAuth?: boolean; title?: string };

/** Analyze one URL, returning the full result (or an error outcome string). */
async function analyzeFull(url: string): Promise<{ result?: AnalyzeResult; error?: Outcome }> {
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
      return { error: `error:${b.error || resp.status}` };
    }
    return { result: (await resp.json()) as AnalyzeResult };
  } catch (e: any) {
    return { error: `error:${e?.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE'}` };
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
  console.log(`  RESULT  ${'NAME'.padEnd(30)}${'CATEGORY'.padEnd(12)}ACTUAL / REASON`);

  const rows: { name: string; url: string; category?: string; ok: boolean }[] = [];
  const currRun: Record<string, boolean> = {};
  let pass = 0;
  const failed: string[] = [];

  for (const e of entries) {
    const { result, error } = await analyzeFull(e.url);
    const { ok, actual, reason } = error
      ? { ok: matchesError(e.expect, error), actual: error, reason: `expected ${expectLabel(e.expect)}, got ${error}` }
      : evaluateExpectation(e.expect, result || {});
    rows.push({ name: e.name, url: e.url, category: e.category, ok });
    currRun[e.url] = ok;
    if (ok) pass++; else failed.push(e.name);
    console.log(
      `  ${(ok ? 'PASS' : 'FAIL').padEnd(6)}  ${(e.name || '').slice(0, 28).padEnd(30)}` +
        `${(e.category || '').padEnd(12)}${ok ? actual : `${actual}  (${reason})`}`,
    );
  }

  // Report card: per-category pass/total.
  console.log('\n  By category:');
  for (const [cat, s] of Object.entries(summarizeByCategory(rows))) {
    console.log(`    ${cat.padEnd(14)} ${s.pass}/${s.total}`);
  }

  // Regression detection vs the previous run (per-machine baseline).
  const runFile = path.resolve('corpus/.last-run.json');
  let prevRun: Record<string, boolean> = {};
  try { prevRun = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch { /* first run */ }
  const { regressions, recoveries } = diffRuns(prevRun, currRun);
  try { fs.writeFileSync(runFile, JSON.stringify(currRun, null, 2)); } catch { /* non-fatal */ }

  console.log(`\n${pass}/${entries.length} passed`);
  if (recoveries.length) console.log(`RECOVERED (${recoveries.length}): ${recoveries.join(', ')}`);
  if (regressions.length) console.log(`REGRESSED (${regressions.length}): ${regressions.join(', ')}`);
  if (failed.length) {
    console.log(`FAILED: ${failed.join(', ')}`);
    process.exit(1);
  }
}

/** Outcome label for an expectation (string or object form), for messages. */
function expectLabel(expect: string | Expectation | undefined): string {
  if (expect === undefined) return 'resolve';
  return typeof expect === 'string' ? expect : (expect.outcome || 'resolve');
}

/** Does an error outcome satisfy the expectation's outcome part? */
function matchesError(expect: string | Expectation | undefined, actual: Outcome): boolean {
  const label = expectLabel(expect);
  if (label === 'error') return actual.startsWith('error');
  return label === actual; // exact 'error:CODE' match, else a non-error expectation fails
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
        const remedy = suggestRemedy(t);
        if (remedy) console.log(`       ${remedy}`);
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

/** Append a site rule to config/siteRules.json (skip if the host already has one). */
function writeSiteRule(rule: SiteRule): { written: boolean; file: string } {
  const file = path.resolve('config/siteRules.json');
  let doc: { rules: SiteRule[] } = { rules: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc = Array.isArray(parsed) ? { rules: parsed } : { rules: parsed.rules || [], ...parsed };
  } catch { /* new file */ }
  const exists = doc.rules.some((r) => (r.match || []).some((m) => rule.match.includes(m)));
  if (exists) return { written: false, file };
  doc.rules.push(rule);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return { written: true, file };
}

/** Append a corpus fixture to corpus/urls.json (skip if the URL is already there). */
function writeCorpusFixture(fixture: CorpusFixture): { written: boolean; file: string } {
  const file = path.resolve('corpus/urls.json');
  let doc: { entries: CorpusFixture[] } = { entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc = { entries: parsed.entries || [], ...parsed };
  } catch { /* new file */ }
  if (doc.entries.some((e) => e.url === fixture.url)) return { written: false, file };
  doc.entries.push(fixture);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return { written: true, file };
}

async function runOnboard(args: string[]): Promise<void> {
  const url = args.find((a) => !a.startsWith('-'));
  if (!url) {
    console.error('usage: netload onboard <url> [--name "Label"] [--write]');
    process.exit(1);
  }
  const nIdx = args.indexOf('--name');
  const name = nIdx >= 0 ? args[nIdx + 1] : undefined;
  const write = args.includes('--write');

  // Health check up front (both calls open a browser; fail fast if it's down).
  try { await fetch(`${API}/api/health`); }
  catch { console.error(`error: cannot reach backend at ${API} — start it (npm run dev) first`); process.exit(1); }

  console.log(`\nOnboarding ${url} — running diagnose + analyze (this opens a headless browser)…`);
  const [diag, analyzed] = await Promise.all([
    fetch(`${API}/api/diagnose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
      .then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as Promise<DiagLike>,
    analyzeFull(url),
  ]);
  const analyze = (analyzed.result || {}) as AnalyzeLike;

  const s = suggestOnboarding(url, name, diag, analyze);

  console.log(`\nHost: ${s.host}`);
  console.log(s.alreadyWorks ? '  STATUS: already works ✔' : '  STATUS: needs a site rule');
  console.log('\n  Notes:');
  for (const n of s.notes) console.log(`    - ${n}`);

  if (s.rule) {
    console.log('\n  Suggested site rule (config/siteRules.json):');
    console.log(JSON.stringify(s.rule, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
  }
  console.log('\n  Corpus fixture (corpus/urls.json):');
  console.log(JSON.stringify(s.fixture, null, 2).split('\n').map((l) => '    ' + l).join('\n'));

  if (write) {
    if (s.rule) {
      const w = writeSiteRule(s.rule);
      console.log(`\n  ${w.written ? 'added rule to' : 'rule already present in'} ${w.file}`);
    }
    const wf = writeCorpusFixture(s.fixture);
    console.log(`  ${wf.written ? 'added fixture to' : 'fixture already present in'} ${wf.file}`);
    console.log('  (siteRules.json hot-reloads; re-run `netload corpus` to verify)');
  } else {
    console.log('\n  (dry run — pass --write to append these to your local siteRules.json + corpus/urls.json)');
  }
  console.log('');
}

async function runLogin(args: string[]): Promise<void> {
  const url = args.find((a) => !a.startsWith('-'));
  if (!url) {
    console.error('usage: netload login <url>');
    process.exit(1);
  }
  try { await fetch(`${API}/api/health`); }
  catch { console.error(`error: cannot reach backend at ${API} — start it (npm run dev) first`); process.exit(1); }

  console.log(`\nOpening a visible browser for ${url}.`);
  console.log('  → Sign in / solve any challenge, then CLOSE the window. The session is captured for next time.\n');

  let resp: Response;
  try {
    resp = await fetch(`${API}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch {
    console.error(`error: cannot reach backend at ${API}`);
    process.exit(1);
  }
  if (!resp.ok) {
    console.error(`error: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const r = (await resp.json()) as { host: string; saved: boolean; cookies: number; reason: string };
  if (r.saved) {
    console.log(`  saved session for ${r.host} (${r.cookies} cookies, ended: ${r.reason}). Downloads for this host will reuse it.`);
  } else {
    console.log(`  no session captured (${r.reason}) — nothing was signed in, or the window closed before any cookies were set.`);
  }
}

async function runSessions(): Promise<void> {
  let resp: Response;
  try { resp = await fetch(`${API}/api/sessions`); }
  catch { console.error(`error: cannot reach backend at ${API} — start it (npm run dev) first`); process.exit(1); }
  const { sessions } = (await resp.json()) as { sessions: { host: string; cookies: number; origins: number; savedAt: number }[] };
  if (!sessions.length) {
    console.log('No saved sessions. Capture one with: netload login <url>');
    return;
  }
  console.log(`  ${'HOST'.padEnd(28)}${'COOKIES'.padEnd(9)}${'STORAGE'.padEnd(9)}AGE`);
  for (const s of sessions) {
    const ageH = Math.max(0, Math.round((Date.now() - s.savedAt) / 3600000));
    const age = ageH < 24 ? `${ageH}h` : `${Math.round(ageH / 24)}d`;
    console.log(`  ${s.host.slice(0, 26).padEnd(28)}${String(s.cookies).padEnd(9)}${String(s.origins).padEnd(9)}${age}`);
  }
}

async function runLogout(args: string[]): Promise<void> {
  const host = args.find((a) => !a.startsWith('-'));
  if (!host) { console.error('usage: netload logout <host>'); process.exit(1); }
  let resp: Response;
  try { resp = await fetch(`${API}/api/sessions/${encodeURIComponent(host)}`, { method: 'DELETE' }); }
  catch { console.error(`error: cannot reach backend at ${API}`); process.exit(1); }
  const { removed } = (await resp.json()) as { removed: boolean };
  console.log(removed ? `removed saved session for ${host}` : `no saved session for ${host}`);
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
  if (argv[0] === 'onboard') {
    await runOnboard(argv.slice(1));
    return;
  }
  if (argv[0] === 'login') {
    await runLogin(argv.slice(1));
    return;
  }
  if (argv[0] === 'sessions') {
    await runSessions();
    return;
  }
  if (argv[0] === 'logout') {
    await runLogout(argv.slice(1));
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
