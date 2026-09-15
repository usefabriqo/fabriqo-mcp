import { inspect } from 'node:util';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import {
  containsOAuthAccessToken,
  oauthAccessTokenSelector,
} from '../src/auth/contract.js';
import {
  CredentialError,
  resolveWorkspaceToken,
  WorkspaceTokenVerifier,
  workspaceIdFromAuthInfo,
} from '../src/auth/credentials.js';
import {
  ACCESS_TOKEN_TYPE,
  OAuthAuthorizationClient,
  OAuthServerError,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from '../src/auth/oauth.js';
import { MCP_SCOPES } from '../src/auth/scopes.js';
import { loadSettings } from '../src/config/settings.js';

const MCP_TOKEN = `fqo_at_${'1'.repeat(24)}_${'m'.repeat(43)}`;
const OTHER_MCP_TOKEN = `fqo_at_${'3'.repeat(24)}_${'n'.repeat(43)}`;
const API_TOKEN = `fqo_at_${'2'.repeat(24)}_${'a'.repeat(43)}`;
const NOW = 2_000_000_000;
const settings = loadSettings({
  FABRIQO_ENV: 'test',
  FABRIQO_API_BASE_URL: 'https://api.example.test',
  FABRIQO_MCP_PUBLIC_URL: 'https://mcp.example.test',
  FABRIQO_OAUTH_ISSUER_URL: 'https://auth.example.test',
  FABRIQO_OAUTH_INTROSPECTION_URL: 'https://auth.example.test/oauth/introspect',
  FABRIQO_OAUTH_TOKEN_URL: 'https://auth.example.test/oauth/token',
  FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID: 'mcp-test',
  FABRIQO_OAUTH_MCP_BACKEND_CLIENT_SECRET: 'confidential-backend-secret',
});

function active(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    active: true,
    token_type: 'Bearer',
    token_kind: 'mcp_access',
    scope: MCP_SCOPES.join(' '),
    client_id: 'https://client.example.test/.well-known/oauth-client',
    sub: '17',
    aud: settings.mcpPublicUrl,
    iss: settings.oauthIssuerUrl,
    iat: NOW - 10,
    exp: NOW + 600,
    workspace_id: 29,
    oauth_grant_id: 23,
    ...overrides,
  };
}
function exchanged(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    access_token: API_TOKEN,
    issued_token_type: ACCESS_TOKEN_TYPE,
    token_type: 'Bearer',
    expires_in: 300,
    scope: 'catalog:read',
    resource: settings.apiBaseUrl,
    ...overrides,
  };
}
function makeClient(
  handler: (request: Request) => Response | Promise<Response>,
  monotonicNow?: () => number,
) {
  const requests: Request[] = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return handler(request);
    },
  );
  const client = new OAuthAuthorizationClient(settings, {
    fetch,
    now: () => NOW,
    monotonicNow,
  });
  return { client, requests, fetch };
}

describe('public OAuth scope and token contract', () => {
  it('preserves exact 16 ordered scope catalogue', () => {
    expect(MCP_SCOPES).toEqual([
      'catalog:read',
      'catalog:write',
      'locations:read',
      'locations:write',
      'suppliers:read',
      'suppliers:write',
      'inventory:read',
      'inventory:write',
      'purchasing:read',
      'purchasing:write',
      'sales:read',
      'sales:write',
      'manufacturing:read',
      'manufacturing:write',
      'reports:read',
      'traceability:read',
    ]);
    expect(new Set(MCP_SCOPES).size).toBe(16);
  });
  it('uses strict opaque access token shape, including no trailing newline', () => {
    expect(oauthAccessTokenSelector(MCP_TOKEN)).toBe('1'.repeat(24));
    for (const value of [
      null,
      undefined,
      `fqo_at_${'A'.repeat(24)}_${'B'.repeat(43)}`,
      `${MCP_TOKEN}x`,
      `${MCP_TOKEN}\n`,
      MCP_TOKEN.replace('fqo_at_', 'fqo_rt_'),
      'fab_test_service-token',
    ])
      expect(oauthAccessTokenSelector(value)).toBeUndefined();
    expect(containsOAuthAccessToken(`retry:${MCP_TOKEN}:do-not-forward`)).toBe(
      true,
    );
    expect(containsOAuthAccessToken('mcp:v1:safe-retry-key')).toBe(false);
  });
});

describe('confidential introspection', () => {
  it('introspects every request without caching and sends only confidential fixed headers', async () => {
    const { client, requests } = makeClient(() =>
      Response.json(active(), {
        headers: { 'set-cookie': 'secret-cookie=value' },
      }),
    );
    expect((await client.introspectMcpToken(MCP_TOKEN))?.workspaceId).toBe(29);
    expect((await client.introspectMcpToken(MCP_TOKEN))?.grantId).toBe(23);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(settings.oauthIntrospectionUrl);
      expect(request.headers.get('authorization')).toBe(
        `Basic ${Buffer.from('mcp-test:confidential-backend-secret').toString('base64')}`,
      );
      expect(
        Object.fromEntries(new URLSearchParams(await request.text())),
      ).toEqual({ token: MCP_TOKEN, token_type_hint: 'access_token' });
      expect(request.credentials).toBe('omit');
      expect(request.redirect).toBe('manual');
      expect(request.headers.has('cookie')).toBe(false);
    }
    client.close();
    expect(client.isStarted).toBe(false);
  });

  it.each([
    ['aud', settings.apiBaseUrl],
    ['iss', 'https://other.example.test'],
    ['token_kind', 'api_access'],
    ['token_type', 'bearer'],
    ['workspace_id', 0],
    ['workspace_id', true],
    ['oauth_grant_id', '23'],
    ['oauth_grant_id', -1],
    ['iat', NOW + 61],
    ['iat', NOW + 601],
    ['exp', NOW],
    ['exp', 0],
    ['exp', '2000000600'],
    ['scope', ''],
    ['scope', 'catalog:read workspace:admin'],
    ['scope', []],
    ['client_id', ''],
    ['sub', 'x'.repeat(129)],
  ])('rejects invalid active claim %s=%s', async (key, value) => {
    const { client } = makeClient(() =>
      Response.json(active({ [key as string]: value })),
    );
    await expect(client.introspectMcpToken(MCP_TOKEN)).rejects.toMatchObject({
      code: 'oauth_introspection_invalid_response',
    });
  });

  it('rejects inactive and malformed/service tokens without exposing them', async () => {
    const { client, requests } = makeClient(() =>
      Response.json({ active: false }),
    );
    expect(await client.introspectMcpToken(MCP_TOKEN)).toBeNull();
    expect(
      await client.introspectMcpToken('fab_test_service-token'),
    ).toBeNull();
    expect(await client.introspectMcpToken('malformed')).toBeNull();
    expect(requests).toHaveLength(1);
    const verifier = new WorkspaceTokenVerifier(client, settings);
    await expect(verifier.verifyAccessToken('malformed')).rejects.toMatchObject(
      { code: OAuthErrorCode.InvalidToken },
    );
  });

  it('accepts a least-privilege grant and keeps concurrent callers/workspaces isolated', async () => {
    const { client } = makeClient(async (request) => {
      const token = new URLSearchParams(await request.text()).get('token');
      await Promise.resolve();
      return Response.json(
        active({
          scope: 'catalog:read',
          workspace_id: token === MCP_TOKEN ? 101 : 202,
        }),
      );
    });
    const verifier = new WorkspaceTokenVerifier(client, settings);
    const [first, second] = await Promise.all([
      verifier.verifyToken(MCP_TOKEN),
      verifier.verifyToken(OTHER_MCP_TOKEN),
    ]);
    expect(first?.scopes).toEqual(['catalog:read']);
    expect(first?.token).toBe(MCP_TOKEN);
    expect(second?.token).toBe(OTHER_MCP_TOKEN);
    expect(workspaceIdFromAuthInfo(first!)).toBe('101');
    expect(workspaceIdFromAuthInfo(second!)).toBe('202');
    expect(
      workspaceIdFromAuthInfo({ ...first!, extra: { workspace_id: true } }),
    ).toBeUndefined();
    expect(
      workspaceIdFromAuthInfo({ ...first!, extra: { workspace_id: '101' } }),
    ).toBeUndefined();
  });
});

describe('narrow Workspace API token exchange', () => {
  it('exchanges for a distinct scoped short-lived token and caches by bearer hash plus scope', async () => {
    const { client, requests } = makeClient(() => Response.json(exchanged()));
    expect(
      await client.exchangeForWorkspaceApi(MCP_TOKEN, [
        'catalog:read',
        'catalog:read',
      ]),
    ).toBe(API_TOKEN);
    expect(
      await client.exchangeForWorkspaceApi(MCP_TOKEN, ['catalog:read']),
    ).toBe(API_TOKEN);
    expect(requests).toHaveLength(1);
    expect(
      Object.fromEntries(new URLSearchParams(await requests[0]!.text())),
    ).toEqual({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      subject_token: MCP_TOKEN,
      subject_token_type: ACCESS_TOKEN_TYPE,
      resource: settings.apiBaseUrl,
      scope: 'catalog:read',
    });
    expect(inspect(client)).not.toContain(MCP_TOKEN);
    expect(inspect(client)).not.toContain(API_TOKEN);
  });

  it('separates cache entries by token and exact scope; expires with 5 second skew', async () => {
    let now = 100;
    const { client, requests } = makeClient(
      async (request) => {
        const scope =
          new URLSearchParams(await request.text()).get('scope') ?? '';
        return Response.json(exchanged({ scope }));
      },
      () => now,
    );
    await client.exchangeForWorkspaceApi(MCP_TOKEN, ['catalog:read']);
    await client.exchangeForWorkspaceApi(OTHER_MCP_TOKEN, ['catalog:read']);
    await client.exchangeForWorkspaceApi(MCP_TOKEN, ['inventory:read']);
    await client.exchangeForWorkspaceApi(MCP_TOKEN, ['catalog:read']);
    expect(requests).toHaveLength(3);
    now = 395;
    await client.exchangeForWorkspaceApi(MCP_TOKEN, ['catalog:read']);
    expect(requests).toHaveLength(4);
    client.close();
    await expect(
      client.exchangeForWorkspaceApi(MCP_TOKEN, ['catalog:read']),
    ).rejects.toMatchObject({ code: 'oauth_backend_unavailable' });
  });

  it('omits the scope parameter for the scope-free workspace tool and requires empty response scope', async () => {
    const { client, requests } = makeClient(() =>
      Response.json(exchanged({ scope: '' })),
    );
    expect(await client.exchangeForWorkspaceApi(MCP_TOKEN, [])).toBe(API_TOKEN);
    expect(new URLSearchParams(await requests[0]!.text()).has('scope')).toBe(
      false,
    );
    for (const scope of [undefined, null, ' ']) {
      const { client: invalid } = makeClient(() =>
        Response.json(exchanged({ scope })),
      );
      await expect(
        invalid.exchangeForWorkspaceApi(MCP_TOKEN, []),
      ).rejects.toMatchObject({
        code: 'oauth_token_exchange_invalid_response',
      });
    }
  });

  it('rejects unknown scope escalation and malformed subject before calling OAuth', async () => {
    const { client, requests } = makeClient(() => Response.json(exchanged()));
    await expect(
      client.exchangeForWorkspaceApi(MCP_TOKEN, ['workspace:admin']),
    ).rejects.toMatchObject({ reauthenticationRequired: true });
    await expect(
      client.exchangeForWorkspaceApi('service-credential', ['catalog:read']),
    ).rejects.toMatchObject({ reauthenticationRequired: true });
    expect(requests).toHaveLength(0);
  });

  it.each([
    { access_token: MCP_TOKEN },
    { access_token: 'workspace-key' },
    { expires_in: 301 },
    { expires_in: true },
    { expires_in: 0 },
    { issued_token_type: 'id_token' },
    { token_type: 'bearer' },
    { scope: 'catalog:read inventory:write' },
    { scope: 'inventory:read' },
    { resource: settings.mcpPublicUrl },
  ])(
    'rejects passthrough, wrong audience, privilege escalation and malformed response: %o',
    async (overrides) => {
      const { client } = makeClient(() => Response.json(exchanged(overrides)));
      await expect(
        client.exchangeForWorkspaceApi(MCP_TOKEN, ['catalog:read']),
      ).rejects.toMatchObject({
        code: 'oauth_token_exchange_invalid_response',
      });
    },
  );
});

describe('OAuth backend failure bounds and safe errors', () => {
  it.each([
    ['17', 17],
    ['9999999999', 60],
    ['Sun, 01 Jan 2027 00:00:00 GMT', undefined],
    ['-1', undefined],
    ['1.5', undefined],
  ])(
    'maps backend rate limits with bounded retry delay %s',
    async (header, expected) => {
      const { client, requests } = makeClient(() =>
        Response.json(
          { error: { message: `private ${MCP_TOKEN}` } },
          {
            status: 429,
            headers: {
              'retry-after': String(header),
              'x-request-id': 'req-123',
            },
          },
        ),
      );
      const error = await client
        .introspectMcpToken(MCP_TOKEN)
        .catch((value: unknown) => value);
      expect(error).toMatchObject({
        code: 'oauth_backend_rate_limited',
        statusCode: 429,
        retryAfterSeconds: expected,
        requestId: 'req-123',
      });
      expect(String(error)).not.toContain(MCP_TOKEN);
      expect(requests).toHaveLength(1);
    },
  );

  it.each([400, 401, 403, 500, 503])(
    'uses safe backend failure for status %s with no retry loop',
    async (status) => {
      const { client, requests } = makeClient(() =>
        Response.json(
          { error: { message: `private ${MCP_TOKEN}` } },
          { status, headers: { 'x-request-id': MCP_TOKEN } },
        ),
      );
      const error = await client
        .introspectMcpToken(MCP_TOKEN)
        .catch((value: unknown) => value);
      expect(error).toMatchObject({
        code: 'oauth_backend_rejected',
        statusCode: status,
        requestId: undefined,
      });
      expect(String(error)).not.toContain(MCP_TOKEN);
      expect(requests).toHaveLength(1);
    },
  );

  it('rejects redirects without following them and refuses a non-JSON or non-object success', async () => {
    for (const response of [
      new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example' },
      }),
      new Response('{}', { headers: { 'content-type': 'text/html' } }),
      Response.json([]),
      Response.json('value'),
      new Response('{', { headers: { 'content-type': 'application/json' } }),
    ]) {
      const { client, requests } = makeClient(() => response);
      await expect(client.introspectMcpToken(MCP_TOKEN)).rejects.toBeInstanceOf(
        OAuthServerError,
      );
      expect(requests).toHaveLength(1);
    }
  });

  it('bounds declared and streamed OAuth bodies at 64 KiB', async () => {
    const oversized = 'a'.repeat(65_537);
    for (const headers of [
      {
        'content-type': 'application/json',
        'content-length': String(oversized.length),
      },
      { 'content-type': 'application/json' },
    ] as HeadersInit[]) {
      const { client } = makeClient(() => new Response(oversized, { headers }));
      await expect(client.introspectMcpToken(MCP_TOKEN)).rejects.toMatchObject({
        code: 'oauth_backend_response_too_large',
      });
    }
  });

  it('discards transport errors, including strings containing secrets', async () => {
    const { client } = makeClient(() => {
      throw new Error(`request failed: ${MCP_TOKEN}`);
    });
    await expect(client.introspectMcpToken(MCP_TOKEN)).rejects.toMatchObject({
      message: 'oauth_backend_unavailable',
    });
  });

  it('retains a bounded retry hint for a temporarily unavailable OAuth backend', async () => {
    const { client } = makeClient(() =>
      Response.json(
        { error: 'backend failure' },
        { status: 503, headers: { 'retry-after': '3' } },
      ),
    );
    await expect(client.introspectMcpToken(MCP_TOKEN)).rejects.toMatchObject({
      statusCode: 503,
      retryAfterSeconds: 3,
    });
  });

  it('aborts confidential calls at the configured deadline and on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const abortable = (request: Request): Promise<Response> =>
        new Promise((_, reject) => {
          if (request.signal.aborted) reject(request.signal.reason);
          else
            request.signal.addEventListener(
              'abort',
              () => reject(request.signal.reason),
              { once: true },
            );
        });
      const { client } = makeClient(abortable);
      const timed = expect(
        client.introspectMcpToken(MCP_TOKEN),
      ).rejects.toMatchObject({ code: 'oauth_backend_unavailable' });
      await vi.advanceTimersByTimeAsync(settings.httpReadTimeoutSeconds * 1000);
      await timed;
      const stopped = expect(
        client.introspectMcpToken(MCP_TOKEN),
      ).rejects.toMatchObject({ code: 'oauth_backend_unavailable' });
      client.close();
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['invalid_grant', 'invalid_request'])(
    'marks %s token exchange errors as requiring reauthentication',
    async (code) => {
      const { client } = makeClient(() =>
        Response.json(
          { error: code, error_description: MCP_TOKEN },
          { status: 400 },
        ),
      );
      await expect(
        client.exchangeForWorkspaceApi(MCP_TOKEN, ['catalog:read']),
      ).rejects.toMatchObject({
        code: 'oauth_subject_token_invalid',
        reauthenticationRequired: true,
      });
    },
  );
});

describe('credential resolution', () => {
  it('stdio requires only the static workspace token and performs no OAuth calls', async () => {
    const local = {
      ...settings,
      apiToken: loadSettings({
        FABRIQO_API_BASE_URL: settings.apiBaseUrl,
        FABRIQO_API_TOKEN: 'local-token',
      }).apiToken,
    };
    expect(
      await resolveWorkspaceToken({ mode: 'stdio' }, 'catalog:write', local),
    ).toBe('local-token');
    await expect(
      resolveWorkspaceToken({ mode: 'stdio' }, 'catalog:read', settings),
    ).rejects.toThrow('FABRIQO_API_TOKEN');
  });

  it('checks per-tool scope before exchange, never returns the incoming bearer, and never falls back to local token', async () => {
    const { client, requests } = makeClient((request) =>
      Response.json(
        request.url.includes('introspect')
          ? active({ scope: 'catalog:read' })
          : exchanged(),
      ),
    );
    const verifier = new WorkspaceTokenVerifier(client, settings);
    const authInfo = (await verifier.verifyToken(MCP_TOKEN))!;
    await expect(
      resolveWorkspaceToken({ mode: 'http' }, 'catalog:read', settings, client),
    ).rejects.toThrow('oauth_authentication_required');
    await expect(
      resolveWorkspaceToken(
        { mode: 'http', authInfo },
        'catalog:read',
        settings,
      ),
    ).rejects.toThrow('oauth_exchange_unavailable');
    await expect(
      resolveWorkspaceToken(
        { mode: 'http', authInfo },
        'inventory:write',
        settings,
        client,
      ),
    ).rejects.toThrow('inventory:write');
    expect(requests).toHaveLength(1);
    const workspaceToken = await resolveWorkspaceToken(
      { mode: 'http', authInfo },
      'catalog:read',
      settings,
      client,
    );
    expect(workspaceToken).toBe(API_TOKEN);
    expect(workspaceToken).not.toBe(MCP_TOKEN);
  });

  it('maps reauthentication and backend exchange errors to safe actionable tool errors', async () => {
    for (const [code, expected] of [
      ['invalid_grant', 'oauth_reauthentication_required'],
      ['invalid_client', 'oauth_exchange_unavailable'],
    ]) {
      const { client } = makeClient(() =>
        Response.json(
          { error: code, error_description: MCP_TOKEN },
          { status: 400 },
        ),
      );
      const authInfo = {
        token: MCP_TOKEN,
        clientId: 'client',
        scopes: ['catalog:read'],
      };
      const error = await resolveWorkspaceToken(
        { mode: 'http', authInfo },
        'catalog:read',
        settings,
        client,
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(CredentialError);
      expect(error).toMatchObject({ code: expected });
      expect(String(error)).not.toContain(MCP_TOKEN);
    }
  });

  it('uses native OAuth errors only for invalid-token challenges', () => {
    const error = new OAuthError(
      OAuthErrorCode.InvalidToken,
      'Invalid access token.',
    );
    expect(error.code).toBe('invalid_token');
  });
});
