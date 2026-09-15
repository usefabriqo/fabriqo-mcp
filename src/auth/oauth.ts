import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { type Settings, validateRemoteOAuth } from '../config/settings.js';
import {
  containsOAuthAccessToken,
  oauthAccessTokenSelector,
} from './contract.js';
import { MCP_SCOPE_SET } from './scopes.js';

export const TOKEN_EXCHANGE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE =
  'urn:ietf:params:oauth:token-type:access_token';
const MAX_EXCHANGE_CACHE_ENTRIES = 10_000;
const EXCHANGE_CACHE_EXPIRY_SKEW_SECONDS = 5;

export class OAuthServerError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode?: number,
    readonly retryAfterSeconds?: number,
    readonly reauthenticationRequired = false,
    readonly requestId?: string,
  ) {
    super(code);
    this.name = 'OAuthServerError';
  }
}

export interface IntrospectedMcpToken {
  clientId: string;
  userId: string;
  workspaceId: number;
  grantId: number;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  claims: Record<string, string | number>;
}

export interface OAuthClientOptions {
  fetch?: typeof globalThis.fetch;
  /** Unix seconds for token claims. */
  now?: () => number;
  /** Monotonic seconds for cache expiry. */
  monotonicNow?: () => number;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeIdentifier(value: unknown, maxLength = 2048): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized &&
    normalized.length <= maxLength &&
    ![...normalized].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
    ? normalized
    : undefined;
}

function scopesFrom(value: unknown): string[] | undefined {
  return typeof value === 'string'
    ? [...new Set(value.split(/\s+/).filter(Boolean))]
    : undefined;
}

function decodeJson(content: Uint8Array): Record<string, unknown> {
  try {
    const payload: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(content),
    );
    if (
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload)
    )
      return payload as Record<string, unknown>;
  } catch {
    /* Malformed backend contents are never included in a public error. */
  }
  throw new OAuthServerError('oauth_backend_invalid_response');
}

/** Confidential OAuth infrastructure only. Workspace operations belong to @usefabriqo/sdk. */
export class OAuthAuthorizationClient {
  readonly #settings: Settings;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #cache = new Map<string, { token: string; expiresAt: number }>();
  readonly #closeController = new AbortController();
  #closed = false;

  constructor(settings: Settings, options: OAuthClientOptions = {}) {
    validateRemoteOAuth(settings);
    this.#settings = settings;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => Date.now() / 1000);
    this.#monotonicNow =
      options.monotonicNow ?? (() => performance.now() / 1000);
  }

  get isStarted(): boolean {
    return !this.#closed;
  }
  close(): void {
    this.#closed = true;
    this.#cache.clear();
    this.#closeController.abort();
  }
  [inspect.custom](): string {
    return `OAuthAuthorizationClient({ isStarted: ${this.isStarted} })`;
  }

  async introspectMcpToken(
    token: string,
    signal?: AbortSignal,
  ): Promise<IntrospectedMcpToken | null> {
    if (!oauthAccessTokenSelector(token)) return null;
    const payload = await this.#postForm(
      this.#settings.oauthIntrospectionUrl,
      { token, token_type_hint: 'access_token' },
      'introspection',
      signal,
    );
    return payload.active === true ? this.#parseIntrospection(payload) : null;
  }

  async exchangeForWorkspaceApi(
    token: string,
    requestedScopes: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.#closed) throw new OAuthServerError('oauth_backend_unavailable');
    signal?.throwIfAborted();
    const scopes = [...new Set(requestedScopes)];
    if (
      !oauthAccessTokenSelector(token) ||
      scopes.some((scope) => !MCP_SCOPE_SET.has(scope))
    )
      throw new OAuthServerError(
        'oauth_subject_token_invalid',
        undefined,
        undefined,
        true,
      );
    const cacheKey = `${createHash('sha256').update(token).digest('hex')}:${JSON.stringify(scopes)}`;
    const cached = this.#cache.get(cacheKey);
    const now = this.#monotonicNow();
    if (cached) {
      this.#cache.delete(cacheKey);
      if (cached.expiresAt > now) {
        this.#cache.set(cacheKey, cached);
        return cached.token;
      }
    }
    const form: Record<string, string> = {
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      subject_token: token,
      subject_token_type: ACCESS_TOKEN_TYPE,
      resource: this.#settings.apiBaseUrl,
    };
    if (scopes.length) form.scope = scopes.join(' ');
    const payload = await this.#postForm(
      this.#settings.oauthTokenUrl,
      form,
      'token_exchange',
      signal,
    );
    const accessToken = safeIdentifier(payload.access_token, 8192);
    const responseScopes = scopesFrom(payload.scope);
    const expiresIn = payload.expires_in;
    if (
      !accessToken ||
      !oauthAccessTokenSelector(accessToken) ||
      accessToken === token ||
      payload.issued_token_type !== ACCESS_TOKEN_TYPE ||
      payload.token_type !== 'Bearer' ||
      !positiveInteger(expiresIn) ||
      expiresIn > 300 ||
      payload.resource !== this.#settings.apiBaseUrl ||
      !responseScopes ||
      (!responseScopes.length && payload.scope !== '') ||
      responseScopes.length !== scopes.length ||
      responseScopes.some((scope, index) => scope !== scopes[index])
    ) {
      throw new OAuthServerError('oauth_token_exchange_invalid_response');
    }
    if (this.#closed) throw new OAuthServerError('oauth_backend_unavailable');
    this.#cache.set(cacheKey, {
      token: accessToken,
      expiresAt:
        now + Math.max(1, expiresIn - EXCHANGE_CACHE_EXPIRY_SKEW_SECONDS),
    });
    while (this.#cache.size > MAX_EXCHANGE_CACHE_ENTRIES)
      this.#cache.delete(this.#cache.keys().next().value!);
    return accessToken;
  }

  async #postForm(
    endpoint: string | undefined,
    data: Record<string, string>,
    operation: 'introspection' | 'token_exchange',
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!endpoint || this.#closed)
      throw new OAuthServerError('oauth_backend_unavailable');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#settings.httpReadTimeoutSeconds * 1000,
    );
    timeout.unref();
    const signals = [
      controller.signal,
      this.#closeController.signal,
      ...(signal ? [signal] : []),
    ];
    try {
      const response = await this.#fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          accept: 'application/json',
          'user-agent': 'Fabriqo-MCP/1.0',
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${this.#settings.oauthMcpBackendClientId!}:${this.#settings.oauthMcpBackendClientSecret!.value()}`, 'utf8').toString('base64')}`,
        },
        body: new URLSearchParams(data),
        signal: AbortSignal.any(signals),
      });
      const content = await this.#boundedBody(response);
      const requestId = this.#safeRequestId(
        response.headers.get('x-request-id'),
        data,
      );
      const rawRetryAfter = response.headers.get('retry-after')?.trim() ?? '';
      const retryAfter = /^[0-9]{1,10}$/.test(rawRetryAfter)
        ? Math.min(Number(rawRetryAfter), 60)
        : undefined;
      if (response.status >= 300 && response.status < 400)
        throw new OAuthServerError(
          'oauth_backend_unexpected_redirect',
          response.status,
          retryAfter,
          false,
          requestId,
        );
      if (response.status === 429) {
        throw new OAuthServerError(
          'oauth_backend_rate_limited',
          429,
          retryAfter,
          false,
          requestId,
        );
      }
      if (response.status !== 200) {
        const reauthenticate =
          operation === 'token_exchange' &&
          response.status === 400 &&
          ['invalid_grant', 'invalid_request'].includes(
            String(decodeJson(content).error),
          );
        throw new OAuthServerError(
          reauthenticate
            ? 'oauth_subject_token_invalid'
            : 'oauth_backend_rejected',
          response.status,
          retryAfter,
          reauthenticate,
          requestId,
        );
      }
      if (
        response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase() !== 'application/json'
      )
        throw new OAuthServerError('oauth_backend_invalid_response');
      return decodeJson(content);
    } catch (error) {
      if (error instanceof OAuthServerError) throw error;
      throw new OAuthServerError('oauth_backend_unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  #safeRequestId(
    raw: string | null,
    data: Record<string, string>,
  ): string | undefined {
    if (
      !raw ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(raw) ||
      containsOAuthAccessToken(raw) ||
      /(?:token|secret|password|credential|authorization|cookie)/i.test(raw)
    )
      return undefined;
    const secrets = [
      data.token,
      data.subject_token,
      this.#settings.oauthMcpBackendClientSecret?.value(),
      this.#settings.apiToken?.value(),
      this.#settings.cfAccessClientId?.value(),
      this.#settings.cfAccessClientSecret?.value(),
    ];
    return secrets.some((value) => value && raw.includes(value))
      ? undefined
      : raw;
  }

  async #boundedBody(response: Response): Promise<Uint8Array> {
    const limit = Math.min(this.#settings.httpMaxResponseBytes, 65_536);
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > limit) {
      await response.body?.cancel();
      throw new OAuthServerError('oauth_backend_response_too_large');
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let observed = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        observed += value.byteLength;
        if (observed > limit) {
          await reader.cancel();
          throw new OAuthServerError('oauth_backend_response_too_large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, observed);
  }

  #parseIntrospection(payload: Record<string, unknown>): IntrospectedMcpToken {
    const now = Math.floor(this.#now());
    const clientId = safeIdentifier(payload.client_id);
    const userId = safeIdentifier(payload.sub, 128);
    const workspaceId = payload.workspace_id;
    const grantId = payload.oauth_grant_id;
    const issuedAt = payload.iat;
    const expiresAt = payload.exp;
    const scopes = scopesFrom(payload.scope);
    if (
      payload.token_type !== 'Bearer' ||
      payload.token_kind !== 'mcp_access' ||
      payload.aud !== this.#settings.mcpPublicUrl ||
      payload.iss !== this.#settings.oauthIssuerUrl ||
      !clientId ||
      !userId ||
      !positiveInteger(workspaceId) ||
      !positiveInteger(grantId) ||
      !positiveInteger(issuedAt) ||
      !positiveInteger(expiresAt) ||
      issuedAt > now + 60 ||
      issuedAt > expiresAt ||
      expiresAt <= now ||
      !scopes?.length ||
      scopes.some((scope) => !MCP_SCOPE_SET.has(scope))
    ) {
      throw new OAuthServerError('oauth_introspection_invalid_response');
    }
    return {
      clientId,
      userId,
      workspaceId,
      grantId,
      issuedAt,
      expiresAt,
      scopes,
      claims: {
        iss: this.#settings.oauthIssuerUrl!,
        aud: this.#settings.mcpPublicUrl!,
        iat: issuedAt,
        workspace_id: workspaceId,
        oauth_grant_id: grantId,
        token_kind: 'mcp_access',
      },
    };
  }
}
