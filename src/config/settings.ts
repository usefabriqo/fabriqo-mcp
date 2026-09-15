import { isIP } from 'node:net';
import { inspect } from 'node:util';

/** Keeps accidental configuration inspection from exposing credentials. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  value(): string {
    return this.#value;
  }
  toString(): string {
    return '[REDACTED]';
  }
  toJSON(): string {
    return '[REDACTED]';
  }
  [inspect.custom](): string {
    return 'Secret([REDACTED])';
  }
}

export type Environment = 'development' | 'staging' | 'production' | 'test';
export type TrustedClientIpMode = 'none' | 'fly' | 'cloudflare';

export interface Settings {
  environment: Environment;
  apiBaseUrl: string;
  apiToken?: Secret;
  mcpPublicUrl?: string;
  oauthIssuerUrl?: string;
  oauthIntrospectionUrl?: string;
  oauthTokenUrl?: string;
  oauthMcpBackendClientId?: string;
  oauthMcpBackendClientSecret?: Secret;
  cfAccessClientId?: Secret;
  cfAccessClientSecret?: Secret;
  /** OAuth and SDK fetch-extension whole-response deadline. */
  httpReadTimeoutSeconds: number;
  /** Response bound; OAuth is additionally capped at 64 KiB. */
  httpMaxResponseBytes: number;
  trustedHosts: readonly string[];
  allowedOrigins: readonly string[];
  maxRequestBodyBytes: number;
  trustedClientIpMode: TrustedClientIpMode;
  authFailureSourceLimit: number;
  authFailureWindowSeconds: number;
  authFailureMaxSources: number;
  appRelease: string;
}

const environmentAliases: Record<string, Environment> = {
  dev: 'development',
  development: 'development',
  local: 'development',
  stg: 'staging',
  stage: 'staging',
  staging: 'staging',
  prd: 'production',
  prod: 'production',
  production: 'production',
  test: 'test',
  testing: 'test',
};

export function isLoopbackHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    value === 'localhost' ||
    (isIP(value) === 4 && value.startsWith('127.')) ||
    value === '::1'
  );
}

function normalizeUrl(raw: string, endpoint: boolean): string {
  const value = raw.trim();
  if (
    !value ||
    value.includes('\\') ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('A valid absolute HTTP URL is required.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('A valid absolute HTTP URL is required.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname)
    throw new Error('A valid absolute HTTP URL is required.');
  if (url.username || url.password || value.includes('@'))
    throw new Error('URL user information is not allowed.');
  if (value.includes('?') || value.includes('#'))
    throw new Error('URL query strings and fragments are not allowed.');
  const parts = /^[a-z]+:\/\/([^/]+)(\/.*)?$/i.exec(value);
  const authority = parts?.[1]?.toLowerCase();
  if (!authority) throw new Error('A valid absolute HTTP URL is required.');
  // Check the supplied host before WHATWG normalization (e.g. 127.1 -> 127.0.0.1).
  const host = authority.startsWith('[')
    ? authority.slice(1, authority.indexOf(']'))
    : authority.split(':')[0]!;
  if (url.protocol !== 'https:' && !isLoopbackHost(host))
    throw new Error(
      'HTTPS is required except for a loopback development endpoint.',
    );
  const suppliedPath = parts?.[2] ?? '';
  if (!endpoint && suppliedPath !== '' && suppliedPath !== '/')
    throw new Error('The URL must be an origin without a path.');
  const path = endpoint ? suppliedPath.replace(/\/+$/, '') : '';
  if (endpoint && !path)
    throw new Error('OAuth endpoint URLs must include a path.');
  return `${url.protocol}//${authority}${path}`;
}

function secret(value: string | undefined): Secret | undefined {
  const normalized = value?.trim();
  return normalized ? new Secret(normalized) : undefined;
}

function csv(value: string | undefined, fallback: readonly string[]): string[] {
  return value === undefined
    ? [...fallback]
    : value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
}

function numeric(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
  integer = true,
): number {
  const raw = env[key];
  const number = raw === undefined ? fallback : Number(raw);
  if (
    raw?.trim() === '' ||
    !Number.isFinite(number) ||
    number < min ||
    number > max ||
    (integer && !Number.isInteger(number))
  ) {
    throw new Error(
      `${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`,
    );
  }
  return number;
}

/** Reads only the standalone MCP configuration; never prints input values. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const environment =
    environmentAliases[(env.FABRIQO_ENV ?? 'development').trim().toLowerCase()];
  if (!environment) throw new Error('Unsupported Fabriqo environment.');
  const cfAccessClientId = secret(env.CF_ACCESS_CLIENT_ID);
  const cfAccessClientSecret = secret(env.CF_ACCESS_CLIENT_SECRET);
  if (Boolean(cfAccessClientId) !== Boolean(cfAccessClientSecret))
    throw new Error(
      'CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be configured together.',
    );
  if (environment === 'production' && cfAccessClientId)
    throw new Error(
      'Cloudflare Access service credentials are forbidden in production MCP.',
    );
  const trustedHosts = [
    ...new Set(
      csv(env.FABRIQO_MCP_TRUSTED_HOSTS, [
        '127.0.0.1',
        'localhost',
        'testserver',
      ]).map((host) => host.toLowerCase()),
    ),
  ];
  if (
    !trustedHosts.length ||
    trustedHosts.some((host) => /[*/?#@\s]/.test(host))
  )
    throw new Error('MCP trusted hosts must contain exact host names only.');
  const allowedOrigins = [
    ...new Set(
      csv(env.FABRIQO_MCP_ALLOWED_ORIGINS, []).map((origin) =>
        normalizeUrl(origin, false),
      ),
    ),
  ];
  const trustedClientIpMode = (env.FABRIQO_MCP_TRUSTED_CLIENT_IP_MODE ?? 'none')
    .trim()
    .toLowerCase();
  if (!['none', 'fly', 'cloudflare'].includes(trustedClientIpMode))
    throw new Error('Invalid FABRIQO_MCP_TRUSTED_CLIENT_IP_MODE.');
  const oauthMcpBackendClientId =
    env.FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID?.trim() || undefined;
  if (
    oauthMcpBackendClientId &&
    (oauthMcpBackendClientId.length > 512 ||
      [...oauthMcpBackendClientId].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  )
    throw new Error('The OAuth backend client ID is invalid.');
  const optionalUrl = (key: string, endpoint: boolean): string | undefined =>
    env[key]?.trim() ? normalizeUrl(env[key]!, endpoint) : undefined;
  return {
    environment,
    apiBaseUrl: normalizeUrl(env.FABRIQO_API_BASE_URL ?? '', false),
    apiToken: secret(env.FABRIQO_API_TOKEN),
    mcpPublicUrl: optionalUrl('FABRIQO_MCP_PUBLIC_URL', false),
    oauthIssuerUrl: optionalUrl('FABRIQO_OAUTH_ISSUER_URL', false),
    oauthIntrospectionUrl: optionalUrl('FABRIQO_OAUTH_INTROSPECTION_URL', true),
    oauthTokenUrl: optionalUrl('FABRIQO_OAUTH_TOKEN_URL', true),
    oauthMcpBackendClientId,
    oauthMcpBackendClientSecret: secret(
      env.FABRIQO_OAUTH_MCP_BACKEND_CLIENT_SECRET,
    ),
    cfAccessClientId,
    cfAccessClientSecret,
    httpReadTimeoutSeconds: numeric(
      env,
      'FABRIQO_MCP_HTTP_READ_TIMEOUT_SECONDS',
      20,
      Number.MIN_VALUE,
      120,
      false,
    ),
    httpMaxResponseBytes: numeric(
      env,
      'FABRIQO_MCP_HTTP_MAX_RESPONSE_BYTES',
      1_048_576,
      1_024,
      16_777_216,
    ),
    trustedHosts,
    allowedOrigins,
    maxRequestBodyBytes: numeric(
      env,
      'FABRIQO_MCP_MAX_REQUEST_BODY_BYTES',
      1_048_576,
      1_024,
      16_777_216,
    ),
    trustedClientIpMode: trustedClientIpMode as TrustedClientIpMode,
    authFailureSourceLimit: numeric(
      env,
      'FABRIQO_MCP_AUTH_FAILURE_SOURCE_LIMIT',
      20,
      1,
      10_000,
    ),
    authFailureWindowSeconds: numeric(
      env,
      'FABRIQO_MCP_AUTH_FAILURE_WINDOW_SECONDS',
      60,
      1,
      3_600,
    ),
    authFailureMaxSources: numeric(
      env,
      'FABRIQO_MCP_AUTH_FAILURE_MAX_SOURCES',
      4_096,
      1,
      100_000,
    ),
    appRelease:
      env.FABRIQO_APP_RELEASE?.trim() ||
      env.FABRIQO_SENTRY_RELEASE?.trim() ||
      '',
  };
}

export function validateRemoteOAuth(settings: Settings): void {
  const configured = {
    FABRIQO_MCP_PUBLIC_URL: settings.mcpPublicUrl,
    FABRIQO_OAUTH_ISSUER_URL: settings.oauthIssuerUrl,
    FABRIQO_OAUTH_INTROSPECTION_URL: settings.oauthIntrospectionUrl,
    FABRIQO_OAUTH_TOKEN_URL: settings.oauthTokenUrl,
    FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID: settings.oauthMcpBackendClientId,
    FABRIQO_OAUTH_MCP_BACKEND_CLIENT_SECRET:
      settings.oauthMcpBackendClientSecret,
  };
  const missing = Object.entries(configured)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length)
    throw new Error(
      `Remote MCP OAuth configuration is incomplete: ${missing.join(', ')}`,
    );
  for (const [name, endpoint, path] of [
    [
      'FABRIQO_OAUTH_INTROSPECTION_URL',
      settings.oauthIntrospectionUrl!,
      '/oauth/introspect',
    ],
    ['FABRIQO_OAUTH_TOKEN_URL', settings.oauthTokenUrl!, '/oauth/token'],
  ]) {
    const url = new URL(endpoint!);
    if (/^https?:\/\/[^/]+/.exec(endpoint!)?.[0] !== settings.oauthIssuerUrl)
      throw new Error(`${name} must use the configured OAuth issuer origin.`);
    if (
      url.pathname !== path ||
      endpoint !== `${settings.oauthIssuerUrl}${path}`
    )
      throw new Error(`${name} must end at ${path}.`);
  }
  if (
    new Set([
      settings.oauthIssuerUrl,
      settings.mcpPublicUrl,
      settings.apiBaseUrl,
    ]).size !== 3
  )
    throw new Error(
      'OAuth issuer, MCP resource, and Workspace API resource must differ.',
    );
  if (
    settings.environment === 'staging' ||
    settings.environment === 'production'
  ) {
    if (
      settings.environment === 'production' &&
      (settings.cfAccessClientId || settings.cfAccessClientSecret)
    )
      throw new Error(
        'Cloudflare Access service credentials are forbidden in production MCP.',
      );
    if (settings.apiToken)
      throw new Error(
        'FABRIQO_API_TOKEN is forbidden for deployed remote MCP.',
      );
    const expectedMode =
      settings.environment === 'staging' ? 'cloudflare' : 'fly';
    if (settings.trustedClientIpMode !== expectedMode)
      throw new Error(
        `FABRIQO_MCP_TRUSTED_CLIENT_IP_MODE must be ${expectedMode} for ${settings.environment}.`,
      );
    if (settings.oauthMcpBackendClientSecret!.value().length < 32)
      throw new Error(
        'FABRIQO_OAUTH_MCP_BACKEND_CLIENT_SECRET must be at least 32 characters.',
      );
    const suffix = settings.environment === 'staging' ? '-staging' : '';
    if (
      settings.oauthIssuerUrl !== `https://auth${suffix}.fabriqo.app` ||
      settings.mcpPublicUrl !== `https://mcp${suffix}.fabriqo.app` ||
      settings.apiBaseUrl !== `https://api${suffix}.fabriqo.app`
    )
      throw new Error(
        'OAuth issuer and resource URLs do not match the configured environment.',
      );
  }
}

/** Only configured server credentials may be used, never inbound headers. */
export function cloudflareAccessHeaders(
  settings: Settings,
): Record<string, string> {
  return settings.cfAccessClientId && settings.cfAccessClientSecret
    ? {
        'CF-Access-Client-Id': settings.cfAccessClientId.value(),
        'CF-Access-Client-Secret': settings.cfAccessClientSecret.value(),
      }
    : {};
}
