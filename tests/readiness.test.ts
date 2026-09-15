import { describe, expect, it } from 'vitest';
import { loadSettings } from '../src/config/settings.js';
import { createReadinessProbe } from '../src/server/readiness.js';

const settings = loadSettings({
  FABRIQO_API_BASE_URL: 'https://api.example.test',
  FABRIQO_OAUTH_ISSUER_URL: 'https://auth.example.test',
  CF_ACCESS_CLIENT_ID: 'server-access-id',
  CF_ACCESS_CLIENT_SECRET: 'server-access-secret',
});

describe('dependency readiness', () => {
  it('checks API and OAuth readiness with only configured Access credentials', async () => {
    const requests: Request[] = [];
    const probe = createReadinessProbe(settings, {
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 200 });
      },
    });
    expect(await probe()).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.example.test/readyz',
      'https://auth.example.test/readyz',
    ]);
    for (const request of requests) {
      expect(request.method).toBe('HEAD');
      expect(request.redirect).toBe('manual');
      expect(request.credentials).toBe('omit');
      expect(request.headers.has('authorization')).toBe(false);
      expect(request.headers.get('cf-access-client-id')).toBe(
        'server-access-id',
      );
      expect(request.headers.get('cf-access-client-secret')).toBe(
        'server-access-secret',
      );
    }
  });

  it.each([302, 401, 403, 429, 500, 503])(
    'fails closed on dependency status %s',
    async (status) => {
      const probe = createReadinessProbe(settings, {
        fetch: async (input) =>
          new Response(null, {
            status: new URL(String(input)).hostname.startsWith('auth')
              ? status
              : 200,
          }),
      });
      expect(await probe()).toBe(false);
    },
  );

  it('shares concurrent probes, caches briefly, and detects dependency failure after expiry', async () => {
    let now = 0;
    let calls = 0;
    let unavailable = false;
    const probe = createReadinessProbe(settings, {
      now: () => now,
      fetch: async () => {
        calls++;
        if (unavailable) throw new Error('private dependency failure');
        return new Response(null, { status: 200 });
      },
    });
    expect(await Promise.all([probe(), probe(), probe()])).toEqual([
      true,
      true,
      true,
    ]);
    expect(calls).toBe(2);
    unavailable = true;
    now = 4999;
    expect(await probe()).toBe(true);
    expect(calls).toBe(2);
    now = 5000;
    expect(await probe()).toBe(false);
    expect(calls).toBe(4);
  });

  it('bounds dependency wait time', async () => {
    const probe = createReadinessProbe(settings, {
      timeoutMs: 10,
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(new Error('timeout')),
            { once: true },
          );
        }),
    });
    expect(await probe()).toBe(false);
  });
});
