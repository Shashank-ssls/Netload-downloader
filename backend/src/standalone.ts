#!/usr/bin/env node
import './standalone-bootstrap'; // MUST be first — sets data/binary paths for the packaged exe

/**
 * standalone.ts — self-contained one-shot downloader (no server, no npm).
 *
 * This is what the packaged `netload.exe` runs: paste a link, it downloads, done.
 * Two modes:
 *   netload.exe <url> [--audio]      download one URL and exit
 *   netload.exe                      interactive prompt loop (paste links until 'q')
 *
 * It drives the SAME pipeline as the server (database task + downloadMedia), just
 * called in-process instead of over HTTP.
 */

import readline from 'readline';
import { randomUUID } from 'crypto';
import { tasks } from './database';
import { downloadMedia } from './downloader';
import { BrowserManager } from './utils/browserManager';
import { suggestRemedy } from './utils/remedy';
import type { ProgressData } from './types';

/** A compact text progress bar. */
function bar(pct: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']';
}

/** Download a single URL: create a task, run the pipeline, print the outcome. */
async function downloadOne(url: string, opts: { audioOnly?: boolean }): Promise<void> {
  const id = randomUUID();
  tasks.create({
    id,
    url,
    title: 'Extracting…',
    status: 'queued',
    format: opts.audioOnly ? 'bestaudio' : undefined,
  });

  let lastPct = -1;
  const onProgress = (d: ProgressData) => {
    const pct = Math.floor(d.progress || 0);
    if (pct !== lastPct) {
      lastPct = pct;
      const speed = d.speed ? ` ${d.speed}` : '';
      const eta = d.eta ? ` ETA ${d.eta}` : '';
      process.stdout.write(`\r  ${bar(pct)} ${String(pct).padStart(3)}%${speed}${eta}        `);
    }
  };

  console.log(`\n▶ ${url}`);
  try {
    await downloadMedia(id, onProgress);
  } catch {
    /* terminal status is read from the task below */
  }
  process.stdout.write('\n');

  const t = tasks.getById(id);
  if (t?.status === 'completed') {
    if (t.note === 'LIKELY_PREVIEW_ADD_COOKIES') {
      console.log(`  ⚠ Got a short preview (full video may need login): ${t.path}`);
      const r = suggestRemedy({ status: t.status, note: t.note, url });
      if (r) console.log(`    ${r}`);
    } else {
      console.log(`  ✓ Saved: ${t.path}`);
    }
  } else {
    console.log(`  ✗ Failed${t?.error ? ` (${t.error})` : ''}`);
    const r = suggestRemedy({ status: t?.status, error: t?.error, note: t?.note, url });
    if (r) console.log(`    ${r}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const audioOnly = argv.includes('--audio');
  const urlArg = argv.find((a) => !a.startsWith('-'));

  if (urlArg) {
    // One-shot mode.
    await downloadOne(urlArg, { audioOnly });
    await BrowserManager.shutdown().catch(() => {});
    return;
  }

  // Interactive mode: paste links until the user quits.
  console.log('netload — paste a video link and press Enter to download.');
  console.log("Type 'q' (or just press Enter on a blank line) to quit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (): void => {
    rl.question('link> ', (line) => {
      const url = line.trim();
      if (!url || url.toLowerCase() === 'q' || url.toLowerCase() === 'quit') {
        rl.close();
        return;
      }
      void downloadOne(url, { audioOnly })
        .catch((e) => console.log(`  ✗ Error: ${e?.message || e}`))
        .finally(ask);
    });
  };
  ask();

  await new Promise<void>((resolve) => rl.on('close', () => resolve()));
  await BrowserManager.shutdown().catch(() => {});
  console.log('\nDone. Bye!');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Fatal:', e?.message || e);
  process.exit(1);
});
