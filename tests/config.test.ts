import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  cloudflareAccessHeaders,
  loadSettings,
  validateRemoteOAuth,
} from '../src/config/settings.js';

const base = { FABRIQO_API_BASE_URL: 'https://api.example.test' };
const remote = {
  ...base,
  FABRIQO_MCP_PUBLIC_URL: 'https://mcp.example.test',
  FABRIQO_OAUTH_ISSUER_URL: 'https://auth.example.test',
  FABRIQO_OAUTH_INTROSPECTION_URL: 'https://auth.example.test/oauth/introspect',
  FABRIQO_OAUTH_TOKEN_URL: 'https://auth.example.test/oauth/token',
  FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID: 'mcp-test',
  FABRIQO_OAUTH_MCP_BACKEND_CLIENT_SECRET: 'backend-secret',
};
const production = {
  FABRIQO_ENV: 'production',
  FABRIQO_API_BASE_URL: 'https://api.fabriqo.app',
  FABRIQO_MCP_PUBLIC_URL: 'https://mcp.fabriqo.app',
  FABRIQO_OAUTH_ISSUER_URL: 'https://auth.fabriqo.app',
  FABRIQO_OAUTH_INTROSPECTION_URL: 'https://auth.fabriqo.app/oauth/introspect',
  FABRIQO_OAUTH_TOKEN_URL: 'https://auth.fabriqo.app/oauth/token',
  FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID: 'fabriqo-mcp',
  FABRIQO_OAUTH_MCP_BACKEND_CLIENT_SECRET: 'a'.repeat(48),
  FABRIQO_MCP_TRUSTED_CLIENT_IP_MODE: 'fly',
};

describe('configuration parity', () => {
  it('normalizes environment, URLs, secrets, CSV lists and release without exposing credentials', () => {
    const settings = loadSettings({
      ...base,
      FABRIQO_ENV: 'stg',
      FABRIQO_API_BASE_URL: 'https://API.EXAMPLE.TEST/',
      FABRIQO_API_TOKEN: ' local-private-key ',
      CF_ACCESS_CLIENT_ID: 'service-id',
      CF_ACCESS_CLIENT_SECRET: 'service-secret',
      FABRIQO_MCP_TRUSTED_HOSTS:
        'MCP.example.test, localhost, MCP.example.test',
      FABRIQO_MCP_ALLOWED_ORIGINS:
        'https://CLIENT.example.test/,http://127.0.0.1:3000',
      FABRIQO_APP_RELEASE: ' release-42 ',
    });
    expect(settings.environment).toBe('staging');
    expect(settings.apiBaseUrl).toBe('https://api.example.test');
    expect(settings.apiToken?.value()).toBe('local-private-key');
    expect(settings.trustedHosts).toEqual(['mcp.example.test', 'localhost']);
    expect(settings.allowedOrigins).toEqual([
      'https://client.example.test',
      'http://127.0.0.1:3000',
    ]);
    expect(settings.appRelease).toBe('release-42');
    expect(cloudflareAccessHeaders(settings)).toEqual({
      'CF-Access-Client-Id': 'service-id',
      'CF-Access-Client-Secret': 'service-secret',
    });
    for (const representation of [
      inspect(settings),
      JSON.stringify(settings),
    ]) {
      for (const value of ['local-private-key', 'service-id', 'service-secret'])
        expect(representation).not.toContain(value);
    }
  });

  it.each([
    '',
    'api.example.test',
    'http://api.example.test',
    'https://user:pass@api.example.test',
    'https://api.example.test/v1',
    'https://api.example.test?target=other',
    'https://api.example.test#fragment',
    'ftp://api.example.test',
    'https://api.example.test\\@other.example',
    'http://127.1:8001',
    'https://api.example.test:65536',
    'https://api.example.test/path/..',
  ])('rejects unsafe API origin %s', (url) => {
    expect(() => loadSettings({ FABRIQO_API_BASE_URL: url })).toThrow();
  });

  it.each([
    'http://localhost:8001',
    'http://127.0.0.1:8001/',
    'http://[::1]:8001',
    'https://api.example.test',
  ])('accepts HTTPS and literal loopback HTTP: %s', (url) => {
    expect(loadSettings({ FABRIQO_API_BASE_URL: url }).apiBaseUrl).toMatch(
      /^https?:\/\//,
    );
  });

  it.each([
    { CF_ACCESS_CLIENT_ID: 'only-id' },
    { CF_ACCESS_CLIENT_SECRET: 'only-secret' },
  ])('requires configured Cloudflare credential pair: %o', (values) => {
    expect(() => loadSettings({ ...base, ...values })).toThrow(
      'must be configured together',
    );
    try {
      loadSettings({ ...base, ...values });
    } catch (error) {
      expect(String(error)).not.toMatch(/only-id|only-secret/);
    }
  });

  it.each([
    { FABRIQO_MCP_TRUSTED_HOSTS: '*' },
    { FABRIQO_MCP_TRUSTED_HOSTS: '' },
    { FABRIQO_MCP_ALLOWED_ORIGINS: '*' },
    { FABRIQO_MCP_TRUSTED_CLIENT_IP_MODE: 'untrusted-proxy' },
    { FABRIQO_MCP_AUTH_FAILURE_MAX_SOURCES: '0' },
    { FABRIQO_MCP_HTTP_READ_TIMEOUT_SECONDS: '0' },
    { FABRIQO_MCP_HTTP_READ_TIMEOUT_SECONDS: 'Infinity' },
    { FABRIQO_MCP_HTTP_MAX_RESPONSE_BYTES: '100' },
    { FABRIQO_MCP_MAX_REQUEST_BODY_BYTES: '16777217' },
    { FABRIQO_MCP_AUTH_FAILURE_SOURCE_LIMIT: '1.5' },
    { FABRIQO_ENV: 'unknown' },
  ])('rejects invalid operational values: %o', (values) => {
    expect(() => loadSettings({ ...base, ...values })).toThrow();
  });

  it('preserves exact defaults and operational environment names', () => {
    const settings = loadSettings(base);
    expect(settings).toMatchObject({
      environment: 'development',
      httpReadTimeoutSeconds: 20,
      httpMaxResponseBytes: 1_048_576,
      trustedHosts: ['127.0.0.1', 'localhost', 'testserver'],
      allowedOrigins: [],
      trustedClientIpMode: 'none',
      maxRequestBodyBytes: 1_048_576,
      authFailureSourceLimit: 20,
      authFailureWindowSeconds: 60,
      authFailureMaxSources: 4096,
    });
    expect(
      loadSettings({
        ...base,
        FABRIQO_MCP_HTTP_READ_TIMEOUT_SECONDS: '7',
        FABRIQO_MCP_TRUSTED_CLIENT_IP_MODE: ' Cloudflare ',
      }),
    ).toMatchObject({
      httpReadTimeoutSeconds: 7,
      trustedClientIpMode: 'cloudflare',
    });
  });

  it('requires complete remote contract and normalizes root/endpoint trailing slash', () => {
    expect(() => validateRemoteOAuth(loadSettings(base))).toThrow('incomplete');
    const settings = loadSettings({
      ...remote,
      FABRIQO_MCP_PUBLIC_URL: 'https://MCP.example.test/',
      FABRIQO_OAUTH_ISSUER_URL: 'https://AUTH.example.test/',
      FABRIQO_OAUTH_INTROSPECTION_URL:
        'https://AUTH.example.test/oauth/introspect/',
      FABRIQO_OAUTH_TOKEN_URL: 'https://AUTH.example.test/oauth/token/',
      FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID: ' mcp-test ',
    });
    expect(() => validateRemoteOAuth(settings)).not.toThrow();
    expect(settings.oauthTokenUrl).toBe(
      'https://auth.example.test/oauth/token',
    );
    expect(settings.oauthMcpBackendClientId).toBe('mcp-test');
  });

  it.each([
    { FABRIQO_OAUTH_TOKEN_URL: 'https://other.example.test/oauth/token' },
    { FABRIQO_OAUTH_TOKEN_URL: 'https://auth.example.test/token' },
    { FABRIQO_MCP_PUBLIC_URL: 'https://api.example.test' },
    { FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID: 'a'.repeat(513) },
    { FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID: 'embedded\nnewline' },
  ])('rejects misconfigured remote contract: %o', (values) => {
    expect(() =>
      validateRemoteOAuth(loadSettings({ ...remote, ...values })),
    ).toThrow();
  });

  it('enforces exact deployed resources, proxy identity source, secret strength and no static credential', () => {
    expect(() => validateRemoteOAuth(loadSettings(production))).not.toThrow();
    expect(() =>
      validateRemoteOAuth(
        loadSettings({ ...production, FABRIQO_API_TOKEN: 'master-token' }),
      ),
    ).toThrow('forbidden');
    expect(() =>
      validateRemoteOAuth(
        loadSettings({
          ...production,
          FABRIQO_MCP_PUBLIC_URL: 'https://mcp-staging.fabriqo.app',
        }),
      ),
    ).toThrow('configured environment');
    expect(() =>
      validateRemoteOAuth(
        loadSettings({
          ...production,
          FABRIQO_OAUTH_MCP_BACKEND_CLIENT_SECRET: 'short',
        }),
      ),
    ).toThrow('at least 32');
    expect(() =>
      validateRemoteOAuth(
        loadSettings({
          ...production,
          FABRIQO_MCP_TRUSTED_CLIENT_IP_MODE: 'cloudflare',
        }),
      ),
    ).toThrow('must be fly for production');
    expect(() =>
      loadSettings({
        ...production,
        CF_ACCESS_CLIENT_ID: 'service-id',
        CF_ACCESS_CLIENT_SECRET: 'service-secret',
      }),
    ).toThrow('forbidden');
    const staging = Object.fromEntries(
      Object.entries(production).map(([key, value]) => [
        key,
        value.replace(
          /https:\/\/(api|mcp|auth)\.fabriqo/g,
          'https://$1-staging.fabriqo',
        ),
      ]),
    );
    staging.FABRIQO_ENV = 'staging';
    staging.FABRIQO_MCP_TRUSTED_CLIENT_IP_MODE = 'cloudflare';
    expect(() => validateRemoteOAuth(loadSettings(staging))).not.toThrow();
    expect(() =>
      validateRemoteOAuth(
        loadSettings({
          ...staging,
          FABRIQO_MCP_TRUSTED_CLIENT_IP_MODE: 'none',
        }),
      ),
    ).toThrow('must be cloudflare for staging');
  });
});
