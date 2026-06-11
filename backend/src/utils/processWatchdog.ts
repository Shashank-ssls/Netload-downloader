/**
 * processWatchdog.ts
 *
 * A universal watchdog for spawned long-running processes (yt-dlp, ffmpeg), so no
 * extraction/download path can hang a worker indefinitely.
 *
 * It is STALL-based, not a flat deadline: a full-movie download can legitimately
 * run for an hour, but a healthy yt-dlp/ffmpeg emits progress on stdout/stderr the
 * whole time. So we kill only when the process goes SILENT for `stallMs` (a true
 * hang — a dead socket, a stuck handshake) — with an optional absolute `hardMs`
 * ceiling as a last-resort backstop. Killing is tree-wide: yt-dlp spawns ffmpeg
 * children and ffmpeg spawns nothing, but on Windows `child.kill()` only reaches
 * the direct child, so we use `taskkill /T`.
 */

import { spawn, type ChildProcess } from 'child_process';
import logger from '../logger';

/** Minimal shape we need from a child process — eases unit testing. */
type KillableChild = Pick<ChildProcess, 'pid' | 'killed'>;

/** Kill a child process and ALL its descendants. */
export function killProcessTree(child: KillableChild): void {
  if (!child.pid || child.killed) return;
  try {
    if (process.platform === 'win32') {
      // Detached + ignored stdio so the killer itself can't hang or block us.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', detached: true }).unref();
    } else {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = process group
    }
  } catch (err: any) {
    logger.warn({ err: err.message, pid: child.pid }, 'killProcessTree failed');
  }
}

export interface Watchdog {
  /** Reset the stall timer — call on every byte of process output. */
  kick(): void;
  /** Clear all timers — call when the process closes. */
  disarm(): void;
  /** Whether the watchdog fired (the process was killed for stalling/overrun). */
  timedOut(): boolean;
}

export interface WatchdogOptions {
  /** Kill if no `kick()` for this long (the primary signal). 0/undefined = off. */
  stallMs?: number;
  /** Absolute ceiling regardless of output. 0/undefined = off. */
  hardMs?: number;
  label: string;
  /** Injectable killer (defaults to killProcessTree) — for unit tests. */
  kill?: (child: KillableChild) => void;
}

/**
 * Arm a watchdog over `child`. Returns handles to kick/disarm and query whether it
 * fired. Pure timer logic (the only side effect is the injectable kill), so it is
 * unit-tested with fake timers.
 */
export function armWatchdog(child: KillableChild, opts: WatchdogOptions): Watchdog {
  const kill = opts.kill ?? killProcessTree;
  let fired = false;
  let stallTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;

  const disarm = (): void => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
  };

  const fire = (why: 'stall' | 'hard-cap'): void => {
    if (fired) return;
    fired = true;
    logger.error({ label: opts.label, why, pid: child.pid, stallMs: opts.stallMs, hardMs: opts.hardMs }, 'Process watchdog fired — killing process tree');
    disarm();
    kill(child);
  };

  const armStall = (): void => {
    if (!opts.stallMs || fired) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => fire('stall'), opts.stallMs);
    if (stallTimer.unref) stallTimer.unref();
  };

  if (opts.hardMs) {
    hardTimer = setTimeout(() => fire('hard-cap'), opts.hardMs);
    if (hardTimer.unref) hardTimer.unref();
  }
  armStall();

  return { kick: armStall, disarm, timedOut: () => fired };
}
