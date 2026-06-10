#!/usr/bin/env node
/**
 * netload — thin CLI over the running backend API.
 *
 *   netload <url> [--audio] [--format <id>] [--playlist] [--subs] [--thumb]
 *
 * Requires the backend to be running (npm run dev / start). Set NETLOAD_API to
 * point at a non-default host (default http://127.0.0.1:4000).
 */

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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
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
