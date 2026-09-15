import { cloudflareAccessHeaders, type Settings } from '../config/settings.js';

/** Dependency probes carry server Access credentials only, never user bearers. */
export function createReadinessProbe(
  settings: Settings,
  options: {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    timeoutMs?: number;
    cacheMs?: number;
  } = {},
): () => Promise<boolean> {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => performance.now());
  let expiresAt = 0;
  let ready = false;
  let pending: Promise<boolean> | undefined;
  return async () => {
    if (now() < expiresAt) return ready;
    if (pending) return pending;
    pending = Promise.all(
      [settings.apiBaseUrl, settings.oauthIssuerUrl!].map(async (origin) => {
        const response = await fetch(new URL('/readyz', origin), {
          method: 'HEAD',
          redirect: 'manual',
          credentials: 'omit',
          headers: cloudflareAccessHeaders(settings),
          signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
        });
        void response.body?.cancel().catch(() => {});
        return response.status === 200;
      }),
    )
      .then((results) => results.every(Boolean))
      .catch(() => false)
      .then((result) => {
        ready = result;
        expiresAt = now() + (options.cacheMs ?? 5000);
        return result;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
