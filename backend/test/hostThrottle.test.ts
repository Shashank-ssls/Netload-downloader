import { describe, it, expect } from 'vitest';
import { HostThrottle } from '../src/utils/hostThrottle';
import { config } from '../src/config';

describe('HostThrottle.hostOf', () => {
  it('extracts a www-stripped lowercase host', () => {
    expect(HostThrottle.hostOf('https://www.Example.com/watch?v=1')).toBe('example.com');
    expect(HostThrottle.hostOf('https://cdn.site.tv/a/b')).toBe('cdn.site.tv');
  });

  it('returns "unknown" for an unparseable URL', () => {
    expect(HostThrottle.hostOf('not a url')).toBe('unknown');
  });
});

describe('HostThrottle.run', () => {
  it('caps concurrent work per host at config.maxPerHostConcurrent', async () => {
    const host = 'throttle-test.example';
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => HostThrottle.run(host, task)));
    expect(maxActive).toBe(config.maxPerHostConcurrent);
  });

  it('does not throttle across different hosts', async () => {
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all([
      HostThrottle.run('host-a.example', task),
      HostThrottle.run('host-b.example', task),
      HostThrottle.run('host-c.example', task),
    ]);
    expect(maxActive).toBe(3); // one each, no cross-host contention
  });
});
