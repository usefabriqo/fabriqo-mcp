import { describe, expect, it } from 'vitest';
import {
  clientNetworkIdentity,
  InvalidTrustedClientIp,
  McpAuthFailureLimiter,
} from '../src/auth/abuse.js';

describe('trusted client identity', () => {
  it('groups IPv6 /64 and maps IPv4-mapped IPv6 to IPv4', () => {
    for (const value of [
      '2001:db8:1:2::1',
      '2001:db8:1:2::ffff',
      '2001:db8:1:2:ffff::1',
    ]) {
      expect(
        clientNetworkIdentity(new Headers({ 'fly-client-ip': value }), 'fly'),
      ).toBe('2001:db8:1:2::/64');
    }
    expect(
      clientNetworkIdentity(new Headers(), 'none', '::ffff:192.0.2.1'),
    ).toBe('192.0.2.1');
    expect(
      clientNetworkIdentity(new Headers(), 'none', '::ffff:c000:201'),
    ).toBe('192.0.2.1');
    expect(clientNetworkIdentity(new Headers(), 'none', '::1')).toBe('::/64');
  });

  it.each(['fly', 'cloudflare'] as const)(
    'trusts only the configured %s header with exactly one valid address',
    (mode) => {
      const header = mode === 'fly' ? 'fly-client-ip' : 'cf-connecting-ip';
      for (const value of [
        '',
        '198.51.100.1, 198.51.100.2',
        'not-an-ip',
        'fe80::1%eth0',
        '127.1',
        'é',
      ]) {
        expect(() =>
          clientNetworkIdentity(
            new Headers({ [header]: value }),
            mode,
            '127.0.0.1',
          ),
        ).toThrow(InvalidTrustedClientIp);
      }
      expect(() =>
        clientNetworkIdentity(new Headers(), mode, '127.0.0.1'),
      ).toThrow(InvalidTrustedClientIp);
      const duplicate = new Headers();
      duplicate.append(header, '198.51.100.1');
      duplicate.append(header, '198.51.100.2');
      expect(() => clientNetworkIdentity(duplicate, mode)).toThrow(
        InvalidTrustedClientIp,
      );
      expect(
        clientNetworkIdentity(
          new Headers({
            [header]: '198.51.100.1',
            'x-forwarded-for': 'attacker',
          }),
          mode,
        ),
      ).toBe('198.51.100.1');
    },
  );

  it('ignores all forwarded headers in none mode', () => {
    const headers = new Headers({
      'fly-client-ip': '198.51.100.2',
      'cf-connecting-ip': '198.51.100.3',
      'x-forwarded-for': '198.51.100.4',
    });
    expect(clientNetworkIdentity(headers, 'none', '203.0.113.1')).toBe(
      '203.0.113.1',
    );
    expect(clientNetworkIdentity(headers, 'none', 'testclient')).toBe(
      'direct-unknown',
    );
  });
});

describe('bounded auth abuse control', () => {
  it('reserves concurrent allowance and counts only failed authentication', () => {
    const limiter = new McpAuthFailureLimiter({
      sourceLimit: 2,
      windowSeconds: 60,
      maxSources: 8,
    });
    const first = limiter.tryReserve('198.51.100.1').reservation!;
    const second = limiter.tryReserve('198.51.100.1').reservation!;
    expect(limiter.tryReserve('198.51.100.1')).toEqual({ retryAfter: 1 });
    limiter.settle(first, false); // 503, successful authentication and protocol errors all refund.
    const third = limiter.tryReserve('198.51.100.1').reservation!;
    limiter.settle(second, true);
    limiter.settle(third, true);
    expect(limiter.tryReserve('198.51.100.1').reservation).toBeUndefined();
    expect(limiter.tryReserve('198.51.100.2').reservation).toBeDefined();
  });

  it('expires failures at the fixed window boundary and returns exact delay', () => {
    let now = 125;
    const limiter = new McpAuthFailureLimiter({
      sourceLimit: 1,
      windowSeconds: 60,
      maxSources: 8,
      clock: () => now,
    });
    limiter.settle(limiter.tryReserve('source').reservation!, true);
    expect(limiter.tryReserve('source')).toEqual({ retryAfter: 55 });
    now = 180;
    limiter.settle(limiter.tryReserve('source').reservation!, false);
    expect(limiter.trackedSources).toEqual([]);
  });

  it('retains in-flight reservations across window boundaries and cannot double-settle', () => {
    let now = 59;
    const limiter = new McpAuthFailureLimiter({
      sourceLimit: 1,
      windowSeconds: 60,
      maxSources: 2,
      clock: () => now,
    });
    const reservation = limiter.tryReserve('source').reservation!;
    now = 60;
    expect(limiter.tryReserve('source')).toEqual({ retryAfter: 1 });
    limiter.settle(reservation, true);
    limiter.settle(reservation, false);
    expect(limiter.tryReserve('source')).toEqual({ retryAfter: 60 });
  });

  it('bounds LRU failure state and never uses a global failure kill switch', () => {
    const limiter = new McpAuthFailureLimiter({
      sourceLimit: 1,
      windowSeconds: 60,
      maxSources: 2,
    });
    for (const source of ['198.51.100.1', '198.51.100.2', '198.51.100.3'])
      limiter.settle(limiter.tryReserve(source).reservation!, true);
    expect(limiter.trackedSources).toEqual(['198.51.100.2', '198.51.100.3']);
    expect(limiter.tryReserve('198.51.100.4').reservation).toBeDefined();
  });

  it('does not evict in-flight sources to exceed global memory bounds', () => {
    const limiter = new McpAuthFailureLimiter({
      sourceLimit: 2,
      windowSeconds: 60,
      maxSources: 1,
    });
    const first = limiter.tryReserve('first').reservation!;
    expect(limiter.tryReserve('second')).toEqual({ retryAfter: 1 });
    limiter.settle(first, false);
    expect(limiter.tryReserve('second').reservation).toBeDefined();
  });
});
