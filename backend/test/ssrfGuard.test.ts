import { describe, it, expect } from 'vitest';
import { SsrfGuard } from '../src/utils/ssrfGuard';

describe('SsrfGuard.isBlockedHost', () => {
  it('blocks loopback / private / link-local IPv4', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '172.31.255.255', '169.254.169.254', '0.0.0.0', '100.64.0.1']) {
      expect(SsrfGuard.isBlockedHost(h), h).toBe(true);
    }
  });

  it('blocks local hostnames and loopback/ULA IPv6', () => {
    for (const h of ['localhost', 'foo.local', 'svc.internal', '::1', 'fc00::1', 'fd12::3', 'fe80::1']) {
      expect(SsrfGuard.isBlockedHost(h), h).toBe(true);
    }
  });

  it('allows ordinary public hosts and non-private IPv4', () => {
    for (const h of ['youtube.com', 'example.com', '8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '192.169.0.1', '11.0.0.1']) {
      expect(SsrfGuard.isBlockedHost(h), h).toBe(false);
    }
  });
});
