import { once } from 'node:events';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TYPE,
  OAuthAuthorizationClient,
} from '../src/auth/oauth.js';
import { MCP_SCOPES } from '../src/auth/scopes.js';
import { loadSettings } from '../src/config/settings.js';
import type { TelemetryEvent } from '../src/observability/index.js';
import { createClientFactory } from '../src/sdk/client-factory.js';
import { createHttpApp, startHttp } from '../src/server/http.js';
import { toolNames } from '../src/tools/contract.js';

const MCP_TOKEN = `fqo_at_${'a'.repeat(24)}_${'A'.repeat(43)}`;
const MCP_TOKEN_B = `fqo_at_${'b'.repeat(24)}_${'B'.repeat(43)}`;
const API_TOKEN = `fqo_at_${'c'.repeat(24)}_${'C'.repeat(43)}`;
const API_TOKEN_B = `fqo_at_${'d'.repeat(24)}_${'D'.repeat(43)}`;
const environment = {
  FABRIQO_ENV: 'test',
  FABRIQO_API_BASE_URL: 'https://api.example.test',
  FABRIQO_MCP_PUBLIC_URL: 'https://mcp.example.test',
  FABRIQO_OAUTH_ISSUER_URL: 'https://auth.example.test',
  FABRIQO_OAUTH_INTROSPECTION_URL: 'https://auth.example.test/oauth/introspect',
  FABRIQO_OAUTH_TOKEN_URL: 'https://auth.example.test/oauth/token',
  FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID: 'backend-client',
  FABRIQO_OAUTH_MCP_BACKEND_CLIENT_SECRET: 'backend-secret',
  FABRIQO_MCP_TRUSTED_HOSTS: 'mcp.example.test,127.0.0.1',
  FABRIQO_MCP_ALLOWED_ORIGINS: 'https://allowed.example.test',
};

function fixture(
  options: {
    scopes?: string[];
    oauthStatus?: number;
    env?: NodeJS.ProcessEnv;
    bodyDeadlineMs?: number;
    inactive?: boolean;
  } = {},
) {
  const settings = loadSettings({ ...environment, ...options.env });
  const events: TelemetryEvent[] = [];
  const oauthRequests: { url: string; body: Record<string, string> }[] = [];
  const apiRequests: Request[] = [];
  const oauth = new OAuthAuthorizationClient(settings, {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = Object.fromEntries(
        new URLSearchParams(await request.text()),
      );
      oauthRequests.push({ url: request.url, body });
      if (options.oauthStatus)
        return Response.json(
          { error: `private ${MCP_TOKEN}` },
          {
            status: options.oauthStatus,
            headers: { 'Retry-After': '3', 'X-Request-ID': 'auth-request' },
          },
        );
      if (request.url === settings.oauthIntrospectionUrl) {
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          active: !options.inactive,
          token_type: 'Bearer',
          token_kind: 'mcp_access',
          scope: (options.scopes ?? [...MCP_SCOPES]).join(' '),
          client_id: 'client',
          sub: '7',
          aud: settings.mcpPublicUrl,
          iss: settings.oauthIssuerUrl,
          iat: now - 10,
          exp: now + 600,
          workspace_id: body.token === MCP_TOKEN_B ? 42 : 41,
          oauth_grant_id: 9,
        });
      }
      return Response.json({
        access_token:
          body.subject_token === MCP_TOKEN_B ? API_TOKEN_B : API_TOKEN,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: 'Bearer',
        expires_in: 300,
        scope: body.scope ?? '',
        resource: settings.apiBaseUrl,
      });
    },
  });
  const clientFactory = createClientFactory({
    baseUrl: settings.apiBaseUrl,
    maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      apiRequests.push(request);
      return Response.json(
        {
          id:
            request.headers.get('authorization') === `Bearer ${API_TOKEN_B}`
              ? 42
              : 41,
          slug: 'workspace',
          name: 'Workspace',
        },
        { headers: { 'X-Request-ID': 'api-request' } },
      );
    },
  });
  const serverOptions = {
    oauth,
    clientFactory,
    telemetry: (event: TelemetryEvent) => {
      events.push(event);
    },
    bodyDeadlineMs: options.bodyDeadlineMs,
  };
  const app = createHttpApp(settings, serverOptions);
  function request(
    path = '/mcp',
    token: string | null = MCP_TOKEN,
    method = 'POST',
    body: unknown = { jsonrpc: '2.0', id: 1, method: 'ping' },
    headers: Record<string, string> = {},
  ) {
    return new Request(`https://mcp.example.test${path}`, {
      method,
      headers: {
        host: 'mcp.example.test',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(!['GET', 'HEAD'].includes(method)
        ? { body: JSON.stringify(body) }
        : {}),
    });
  }
  const call = (
    name: string,
    args: Record<string, unknown> = {},
    token = MCP_TOKEN,
  ) =>
    app.fetch(
      request('/mcp', token, 'POST', {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    );
  return {
    settings,
    app,
    request,
    call,
    oauthRequests,
    apiRequests,
    events,
    serverOptions,
  };
}

describe('remote MCP HTTP', () => {
  it('serves public operational probes and exact native resource metadata without auth dependency calls', async () => {
    const f = fixture();
    for (const [path, payload] of [
      ['/healthz', { status: 'ok', surface: 'mcp' }],
      ['/readyz', { status: 'ready', surface: 'mcp' }],
    ] as const) {
      const response = await f.app.fetch(f.request(path, null, 'GET'));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual(payload);
    }
    const metadata = await f.app.fetch(
      f.request('/.well-known/oauth-protected-resource', null, 'GET'),
    );
    expect(await metadata.json()).toEqual({
      resource: f.settings.mcpPublicUrl,
      authorization_servers: [f.settings.oauthIssuerUrl],
      scopes_supported: MCP_SCOPES,
      bearer_methods_supported: ['header'],
    });
    expect(metadata.headers.has('access-control-allow-origin')).toBe(false);
    expect(f.oauthRequests).toHaveLength(0);
    expect(f.apiRequests).toHaveLength(0);
    await f.app.close();
    expect((await f.app.fetch(f.request('/readyz', null, 'GET'))).status).toBe(
      503,
    );
  });

  it.each([null, '', 'fab_test_workspace-token', 'invalid-token'])(
    'rejects missing or malformed bearer %s before introspection',
    async (token) => {
      const f = fixture();
      const response = await f.app.fetch(f.request('/mcp', token));
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain(
        'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"',
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(f.oauthRequests).toHaveLength(0);
      await f.app.close();
    },
  );

  it('requires available dependencies for readiness while liveness remains available', async () => {
    const f = fixture();
    const app = createHttpApp(f.settings, {
      ...f.serverOptions,
      readinessProbe: async () => false,
    });
    try {
      expect((await app.fetch(f.request('/healthz', null, 'GET'))).status).toBe(
        200,
      );
      const response = await app.fetch(f.request('/readyz', null, 'GET'));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: 'not_ready',
        surface: 'mcp',
      });
      const discovery = await app.fetch(
        f.request('/.well-known/oauth-protected-resource/mcp', null, 'GET'),
      );
      expect((await discovery.json()).resource).toBe(f.settings.mcpPublicUrl);
      expect(f.oauthRequests).toHaveLength(0);
      expect(f.apiRequests).toHaveLength(0);
    } finally {
      await app.close();
      await f.app.close();
    }
  });

  it('rejects inactive bearer after introspection and exposes no credential', async () => {
    const f = fixture({ inactive: true });
    const response = await f.app.fetch(f.request());
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(MCP_TOKEN);
    expect(f.apiRequests).toHaveLength(0);
    await f.app.close();
  });

  it.each(['legacy', 'modern'] as const)(
    'serves native %s protocol statelessly with official client and tool scopes',
    async (era) => {
      const f = fixture({ scopes: ['catalog:read'] });
      const statuses: number[] = [];
      const transport = new StreamableHTTPClientTransport(
        new URL('/mcp', f.settings.mcpPublicUrl!),
        {
          requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
          fetch: async (input, init) => {
            const request = new Request(input, init);
            request.headers.set('host', 'mcp.example.test');
            const response = await f.app.fetch(request);
            statuses.push(response.status);
            expect(response.headers.has('mcp-session-id')).toBe(false);
            return response;
          },
        },
      );
      const client = new Client(
        { name: 'http-test', version: '1' },
        {
          versionNegotiation: {
            mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy',
          },
        },
      );
      try {
        await client.connect(transport);
        expect(client.getProtocolEra()).toBe(era);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
          [...toolNames].sort(),
        );
        const read = await client.callTool({
          name: 'list_products',
          arguments: {},
        });
        expect(read.isError).not.toBe(true);
        const forbidden = await client.callTool({
          name: 'adjust_inventory',
          arguments: { item_id: 1, location_id: 2, quantity_delta: 1 },
        });
        expect(forbidden.isError).toBe(true);
        expect(JSON.stringify(forbidden)).toContain('inventory:write');
        expect(f.apiRequests).toHaveLength(1);
        expect(f.apiRequests[0]?.headers.get('authorization')).toBe(
          `Bearer ${API_TOKEN}`,
        );
        expect(f.apiRequests[0]?.headers.get('authorization')).not.toContain(
          MCP_TOKEN,
        );
        const exchanges = f.oauthRequests.filter(
          (request) => request.body.grant_type,
        );
        expect(exchanges).toHaveLength(1);
        expect(exchanges[0]?.body.scope).toBe('catalog:read');
        expect(
          f.oauthRequests.filter((request) => request.body.token),
        ).toHaveLength(statuses.length);
      } finally {
        await client.close();
        await f.app.close();
      }
    },
  );

  it('isolates simultaneous callers and exchanges the scope-free workspace operation', async () => {
    const f = fixture();
    const responses = await Promise.all([
      f.call('get_workspace', {}, MCP_TOKEN),
      f.call('get_workspace', {}, MCP_TOKEN_B),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(
        JSON.parse(
          (await response.text())
            .replace(/^event: message\s*data: /, '')
            .trim(),
        ),
      ).toMatchObject({
        result: { structuredContent: { data: { slug: 'workspace' } } },
      });
    }
    expect(
      new Set(
        f.apiRequests.map((request) => request.headers.get('authorization')),
      ),
    ).toEqual(new Set([`Bearer ${API_TOKEN}`, `Bearer ${API_TOKEN_B}`]));
    expect(
      f.oauthRequests
        .filter((request) => request.body.grant_type)
        .every((request) => request.body.scope === undefined),
    ).toBe(true);
    await f.app.close();
  });

  it.each([429, 503])(
    'maps auth backend %s safely with metadata',
    async (status) => {
      const f = fixture({ oauthStatus: status });
      const response = await f.app.fetch(f.request());
      expect(response.status).toBe(status);
      expect(response.headers.get('retry-after')).toBe('3');
      expect(response.headers.get('x-request-id')).toBe('auth-request');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).not.toContain(MCP_TOKEN);
      await f.app.close();
    },
  );

  it('validates exact host/origin on all routes and serves only the /mcp endpoint', async () => {
    const f = fixture();
    expect((await f.app.fetch(f.request('/'))).status).toBe(404);
    expect(
      (
        await f.app.fetch(
          f.request('/healthz', null, 'GET', {}, { host: 'attacker.example' }),
        )
      ).status,
    ).toBe(400);
    for (const host of [
      'attacker@mcp.example.test',
      'mcp.example.test/path',
      'mcp.example.test?x',
      'mcp.example.test#x',
      'mcp.example.test,evil.test',
    ])
      expect(
        (await f.app.fetch(f.request('/healthz', null, 'GET', {}, { host })))
          .status,
      ).toBe(400);
    for (const origin of [
      'https://attacker.example',
      'https://allowed.example.test:444',
      'http://allowed.example.test',
      'null',
      '',
    ]) {
      const response = await f.app.fetch(
        f.request('/mcp', MCP_TOKEN, 'POST', {}, { origin }),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('attacker');
    }
    expect(
      (
        await f.app.fetch(
          f.request(
            '/healthz',
            null,
            'GET',
            {},
            { origin: 'https://allowed.example.test' },
          ),
        )
      ).status,
    ).toBe(200);
    expect(f.oauthRequests).toHaveLength(0);
    await f.app.close();
  });

  it('enforces request byte limits before introspection and protects slow body receipt', async () => {
    const f = fixture({
      env: { FABRIQO_MCP_MAX_REQUEST_BODY_BYTES: '1024' },
      bodyDeadlineMs: 20,
    });
    const tooLarge = await f.app.fetch(
      f.request('/mcp', MCP_TOKEN, 'POST', { data: 'x'.repeat(1025) }),
    );
    expect(tooLarge.status).toBe(413);
    const request = f.request();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
    });
    const slow = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const response = await f.app.fetch(slow);
    expect(response.status).toBe(408);
    expect(await response.text()).toContain('request_body_timeout');
    expect(f.oauthRequests).toHaveLength(0);
    await f.app.close();
  });

  it('limits invalid-token attempts before expensive OAuth work and leaves public probes available', async () => {
    const f = fixture({
      inactive: true,
      env: { FABRIQO_MCP_AUTH_FAILURE_SOURCE_LIMIT: '2' },
    });
    expect((await f.app.fetch(f.request())).status).toBe(401);
    expect((await f.app.fetch(f.request())).status).toBe(401);
    const blocked = await f.app.fetch(f.request());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.has('retry-after')).toBe(true);
    expect(f.oauthRequests).toHaveLength(2);
    expect((await f.app.fetch(f.request('/healthz', null, 'GET'))).status).toBe(
      200,
    );
    await f.app.close();
  });

  it('keeps attacker-controlled tool names, keys, tokens and backend text out of logs', async () => {
    const f = fixture();
    for (const response of [
      await f.call(MCP_TOKEN),
      await f.call('get_workspace', { [MCP_TOKEN]: true }),
    ])
      expect(await response.text()).not.toContain(MCP_TOKEN);
    await f.call('get_workspace');
    expect(JSON.stringify(f.events)).not.toMatch(
      /fqo_at_|backend-secret|Authorization/,
    );
    await f.app.close();
  });

  it('serves the actual Node adapter with native protocol discovery', async () => {
    const f = fixture();
    const hosted = startHttp(f.settings, { ...f.serverOptions, port: 0 });
    try {
      await once(hosted.server, 'listening');
      const address = hosted.server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing test listener');
      const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
      const client = new Client(
        { name: 'node-http-test', version: '1' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      try {
        await client.connect(
          new StreamableHTTPClientTransport(url, {
            requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } },
          }),
        );
        expect((await client.listTools()).tools).toHaveLength(45);
        expect(
          (await client.callTool({ name: 'get_workspace', arguments: {} }))
            .isError,
        ).not.toBe(true);
      } finally {
        await client.close();
      }
      expect((await fetch(new URL('/healthz', url))).status).toBe(200);
    } finally {
      await hosted.close();
      await f.app.close();
    }
  });
});
