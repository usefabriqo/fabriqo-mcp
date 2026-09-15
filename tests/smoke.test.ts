import { afterEach, describe, expect, it, vi } from 'vitest';
import { remoteSmokeConfig, runRemoteSmoke } from '../scripts/smoke.js';
import {
  ACCESS_TOKEN_TYPE,
  OAuthAuthorizationClient,
} from '../src/auth/oauth.js';
import { MCP_SCOPES } from '../src/auth/scopes.js';
import { loadSettings } from '../src/config/settings.js';
import { createClientFactory } from '../src/sdk/client-factory.js';
import { createHttpApp } from '../src/server/http.js';

const MCP_TOKEN = `fqo_at_${'a'.repeat(24)}_${'A'.repeat(43)}`;
const LIMITED_TOKEN = `fqo_at_${'b'.repeat(24)}_${'B'.repeat(43)}`;
const API_TOKEN = `fqo_at_${'c'.repeat(24)}_${'C'.repeat(43)}`;
const environment = {
  FABRIQO_MCP_SMOKE_BASE_URL: 'https://mcp-staging.example.test/mcp',
  FABRIQO_MCP_SMOKE_OAUTH_ACCESS_TOKEN: MCP_TOKEN,
};
const writeEnvironment = {
  ...environment,
  FABRIQO_MCP_SMOKE_WORKSPACE_KIND: 'staging',
  FABRIQO_MCP_SMOKE_WORKSPACE_ID: '41',
  FABRIQO_MCP_SMOKE_PRODUCT_SKU: 'mcp-smoke-release-001',
  FABRIQO_MCP_SMOKE_IDEMPOTENCY_KEY: 'mcp-smoke:release-001',
};

function fixture(
  options: {
    workspaceId?: number;
    writeStatus?: number;
    omitReplay?: boolean;
  } = {},
) {
  const settings = loadSettings({
    FABRIQO_ENV: 'test',
    FABRIQO_API_BASE_URL: 'https://api.example.test',
    FABRIQO_MCP_PUBLIC_URL: 'https://mcp-staging.example.test',
    FABRIQO_MCP_TRUSTED_HOSTS: 'mcp-staging.example.test',
    FABRIQO_OAUTH_ISSUER_URL: 'https://auth.example.test',
    FABRIQO_OAUTH_INTROSPECTION_URL:
      'https://auth.example.test/oauth/introspect',
    FABRIQO_OAUTH_TOKEN_URL: 'https://auth.example.test/oauth/token',
    FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID: 'test-client',
    FABRIQO_OAUTH_MCP_BACKEND_CLIENT_SECRET: 'fixture-secret',
  });
  const oauthRequests: Record<string, string>[] = [];
  const apiRequests: Request[] = [];
  const oauth = new OAuthAuthorizationClient(settings, {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const form = Object.fromEntries(
        new URLSearchParams(await request.text()),
      );
      oauthRequests.push(form);
      if (request.url === settings.oauthIntrospectionUrl) {
        if (![MCP_TOKEN, LIMITED_TOKEN].includes(form.token!))
          return Response.json({ active: false });
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          active: true,
          token_type: 'Bearer',
          token_kind: 'mcp_access',
          scope: (form.token === LIMITED_TOKEN
            ? ['locations:read']
            : [...MCP_SCOPES]
          ).join(' '),
          client_id: 'fixture-client',
          sub: '7',
          aud: settings.mcpPublicUrl,
          iss: settings.oauthIssuerUrl,
          iat: now - 10,
          exp: now + 300,
          workspace_id: options.workspaceId ?? 41,
          oauth_grant_id: 9,
        });
      }
      return Response.json({
        access_token: API_TOKEN,
        token_type: 'Bearer',
        issued_token_type: ACCESS_TOKEN_TYPE,
        expires_in: 300,
        scope: form.scope ?? '',
        resource: settings.apiBaseUrl,
      });
    },
  });
  let writes = 0;
  const app = createHttpApp(settings, {
    oauth,
    telemetry: () => {},
    clientFactory: createClientFactory({
      baseUrl: settings.apiBaseUrl,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        apiRequests.push(request);
        const headers = { 'X-Request-ID': `smoke-api-${apiRequests.length}` };
        const path = new URL(request.url).pathname;
        if (path === '/v1/workspace')
          return Response.json(
            {
              id: options.workspaceId ?? 41,
              name: 'Staging fixture',
              slug: 'staging-fixture',
            },
            { headers },
          );
        if (path === '/v1/products/999')
          return Response.json(
            { error: { code: 'not_found', message: 'Product not found.' } },
            { status: 404, headers },
          );
        if (request.method === 'POST') {
          writes += 1;
          if (options.writeStatus)
            return Response.json(
              { error: { code: 'temporary_failure', message: 'Unavailable.' } },
              { status: options.writeStatus, headers },
            );
          return Response.json(
            { id: 100, replayed: !options.omitReplay && writes > 1 },
            { status: writes > 1 ? 200 : 201, headers },
          );
        }
        return Response.json({ items: [], next_cursor: null }, { headers });
      },
    }),
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.redirect).toBe('error');
    expect(new URL(request.url).origin).toBe(
      'https://mcp-staging.example.test',
    );
    request.headers.set('host', 'mcp-staging.example.test');
    return app.fetch(request);
  });
  return { app, apiRequests, oauthRequests };
}

afterEach(() => vi.restoreAllMocks());

describe('remote release smoke safety', () => {
  it('checks real MCP framing, representative SDK reads, OAuth exchange and explicit missing checks without writes', async () => {
    const f = fixture();
    try {
      const summary = await runRemoteSmoke(remoteSmokeConfig(environment));
      expect(summary).toMatchObject({
        mode: 'remote',
        tools: 45,
        workspaceRead: true,
        missingAndInvalidBearer: true,
        inputErrorNormalization: true,
        requestIds: true,
        reads: [
          'get_workspace',
          'list_products',
          'list_locations',
          'list_production_runs',
        ],
      });
      expect(summary.skipped).toHaveLength(3);
      expect(f.apiRequests).toHaveLength(4);
      expect(f.apiRequests.every((request) => request.method === 'GET')).toBe(
        true,
      );
      expect(
        f.apiRequests.every(
          (request) =>
            request.headers.get('authorization') === `Bearer ${API_TOKEN}`,
        ),
      ).toBe(true);
      expect(
        f.apiRequests.every(
          (request) =>
            !request.headers.get('authorization')?.includes(MCP_TOKEN),
        ),
      ).toBe(true);
      expect(
        f.oauthRequests.some(
          (form) =>
            form.token && ![MCP_TOKEN, LIMITED_TOKEN].includes(form.token),
        ),
      ).toBe(true);
      expect(
        f.oauthRequests
          .filter((form) => form.grant_type)
          .map((form) => form.scope ?? ''),
      ).toEqual(['', 'catalog:read', 'locations:read', 'manufacturing:read']);
    } finally {
      await f.app.close();
    }
  });

  it('replays one successful staging fixture write with the same key and checks upstream errors and insufficient scope', async () => {
    const f = fixture();
    try {
      const summary = await runRemoteSmoke(
        remoteSmokeConfig(
          {
            ...writeEnvironment,
            FABRIQO_MCP_SMOKE_INSUFFICIENT_SCOPE_TOKEN: LIMITED_TOKEN,
            FABRIQO_MCP_SMOKE_MISSING_PRODUCT_ID: '999',
          },
          false,
          true,
        ),
      );
      expect(summary).toMatchObject({
        idempotentWrite: true,
        insufficientScope: true,
        upstreamErrorNormalization: true,
        skipped: [],
      });
      const writes = f.apiRequests.filter(
        (request) => request.method === 'POST',
      );
      expect(writes).toHaveLength(2);
      expect(
        writes.map((request) => request.headers.get('idempotency-key')),
      ).toEqual(['mcp-smoke:release-001', 'mcp-smoke:release-001']);
      expect(await writes[0]!.text()).toBe(await writes[1]!.text());
      expect(
        f.oauthRequests.filter((form) => form.subject_token === LIMITED_TOKEN),
      ).toEqual([expect.objectContaining({ subject_token: LIMITED_TOKEN })]);
      expect(
        f.oauthRequests.some(
          (form) =>
            form.subject_token === LIMITED_TOKEN &&
            form.scope === 'catalog:read',
        ),
      ).toBe(false);
    } finally {
      await f.app.close();
    }
  });

  it('stops before writes when the bearer selects a different workspace', async () => {
    const f = fixture({ workspaceId: 42 });
    try {
      await expect(
        runRemoteSmoke(remoteSmokeConfig(writeEnvironment, false, true)),
      ).rejects.toThrow('does not match');
      expect(f.apiRequests.every((request) => request.method === 'GET')).toBe(
        true,
      );
    } finally {
      await f.app.close();
    }
  });

  it('never retries a failed write, including SDK retries', async () => {
    const f = fixture({ writeStatus: 503 });
    try {
      await expect(
        runRemoteSmoke(remoteSmokeConfig(writeEnvironment, false, true)),
      ).rejects.toThrow('staging write failed');
      expect(
        f.apiRequests.filter((request) => request.method === 'POST'),
      ).toHaveLength(1);
    } finally {
      await f.app.close();
    }
  });

  it('fails when a duplicate write does not report replay', async () => {
    const f = fixture({ omitReplay: true });
    try {
      await expect(
        runRemoteSmoke(remoteSmokeConfig(writeEnvironment, false, true)),
      ).rejects.toThrow('replay did not preserve');
    } finally {
      await f.app.close();
    }
  });

  it('requires explicit staging write fixtures and forbids production writes', () => {
    expect(remoteSmokeConfig(writeEnvironment).write).toBeUndefined();
    expect(() => remoteSmokeConfig(environment, false, true)).toThrow(
      'WORKSPACE_KIND=staging',
    );
    expect(() =>
      remoteSmokeConfig(
        { ...writeEnvironment, FABRIQO_MCP_SMOKE_WORKSPACE_ID: undefined },
        false,
        true,
      ),
    ).toThrow('explicit workspace ID');
    expect(() => remoteSmokeConfig(writeEnvironment, true, true)).toThrow(
      'cannot run in production',
    );
    expect(() =>
      remoteSmokeConfig(
        {
          ...writeEnvironment,
          FABRIQO_MCP_SMOKE_BASE_URL: 'https://mcp.fabriqo.app/mcp',
        },
        true,
        true,
      ),
    ).toThrow('cannot run in production');
  });

  it('validates all additional fixture configuration without printing credentials', () => {
    expect(() =>
      remoteSmokeConfig({
        ...environment,
        FABRIQO_MCP_SMOKE_INSUFFICIENT_SCOPE_TOKEN: MCP_TOKEN,
      }),
    ).toThrow('different MCP OAuth');
    expect(() =>
      remoteSmokeConfig({
        ...environment,
        FABRIQO_MCP_SMOKE_RESOURCE_URL: 'https://attacker.example',
      }),
    ).toThrow('OAuth resource');
    expect(() =>
      remoteSmokeConfig({
        ...environment,
        FABRIQO_MCP_SMOKE_ORDER_TOOL: 'create_product',
      }),
    ).toThrow('order read');
    expect(() =>
      remoteSmokeConfig({
        ...environment,
        FABRIQO_MCP_SMOKE_MISSING_PRODUCT_ID: '0',
      }),
    ).toThrow('positive safe integer');
  });
});
