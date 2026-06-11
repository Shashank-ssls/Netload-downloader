import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { armWatchdog } from '../src/utils/processWatchdog';

const fakeChild = () => ({ pid: 4242, killed: false });

describe('armWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires and kills after a stall with no output', () => {
    const kill = vi.fn();
    const wd = armWatchdog(fakeChild(), { stallMs: 1000, label: 't', kill });
    expect(wd.timedOut()).toBe(false);
    vi.advanceTimersByTime(999);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(wd.timedOut()).toBe(true);
  });

  it('kick() resets the stall timer', () => {
    const kill = vi.fn();
    const wd = armWatchdog(fakeChild(), { stallMs: 1000, label: 't', kill });
    vi.advanceTimersByTime(900);
    wd.kick();
    vi.advanceTimersByTime(900);   // 1800ms total, but only 900 since the kick
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);   // now 1000ms since the kick
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('disarm() prevents firing', () => {
    const kill = vi.fn();
    const wd = armWatchdog(fakeChild(), { stallMs: 1000, label: 't', kill });
    wd.disarm();
    vi.advanceTimersByTime(5000);
    expect(kill).not.toHaveBeenCalled();
    expect(wd.timedOut()).toBe(false);
  });

  it('the hard cap fires even while output keeps kicking', () => {
    const kill = vi.fn();
    const wd = armWatchdog(fakeChild(), { stallMs: 1000, hardMs: 2500, label: 't', kill });
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(500); wd.kick(); } // 2500ms, kicked every 500
    expect(kill).toHaveBeenCalledTimes(1); // stall never hit, but hard cap did
    expect(wd.timedOut()).toBe(true);
  });

  it('kills at most once', () => {
    const kill = vi.fn();
    const wd = armWatchdog(fakeChild(), { stallMs: 1000, hardMs: 1000, label: 't', kill });
    vi.advanceTimersByTime(5000);
    expect(kill).toHaveBeenCalledTimes(1); // stall + hard cap both elapsed, but fired once
    expect(wd.timedOut()).toBe(true);
  });

  it('never fires with no stall and no hard cap', () => {
    const kill = vi.fn();
    const wd = armWatchdog(fakeChild(), { label: 't', kill });
    vi.advanceTimersByTime(1_000_000);
    expect(kill).not.toHaveBeenCalled();
    expect(wd.timedOut()).toBe(false);
  });
});
