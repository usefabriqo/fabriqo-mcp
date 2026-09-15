import { describe, expect, it } from 'vitest';
import {
  createTelemetry,
  type TelemetryEvent,
} from '../src/observability/index.js';
import { ToolResult } from '../src/schemas/index.js';
import { createClientFactory } from '../src/sdk/client-factory.js';
import { executeTool } from '../src/tools/register-tools.js';

// Computed synthetic markers only; these never authenticate against a service.
const backendSecret = ['synthetic', 'oauth', 'backend', 'credential'].join('-');
const workspaceToken = ['synthetic', 'workspace', 'credential'].join('-');
const oauthToken = `fqo_at_${'a'.repeat(24)}_${'B'.repeat(43)}`;
const legacyToken = ['fab', 'synthetic', 'configured', 'credential'].join('_');

function telemetryCapture() {
  const events: TelemetryEvent[] = [];
  const telemetry = createTelemetry((event) => events.push(event));
  return {
    events,
    onToolEvent: (event: { requestId?: string }) =>
      telemetry({ event: 'mcp_tool_call', requestId: event.requestId }),
  };
}

describe('tool credential output boundary', () => {
  it.each([200, 422])(
    'removes configured OAuth secrets from HTTP %i result metadata and logs',
    async (status) => {
      const { events, onToolEvent } = telemetryCapture();
      const result = await executeTool(
        'get_workspace',
        {},
        {
          resolveCredential: async () => workspaceToken,
          secrets: [backendSecret],
          onToolEvent,
          clientFactory: createClientFactory({
            baseUrl: 'https://api.example.test',
            fetch: async () =>
              Response.json(
                status === 200
                  ? { id: 1, name: 'Workspace' }
                  : {
                      error: { code: 'validation_error', message: 'Invalid.' },
                    },
                { status, headers: { 'X-Request-ID': backendSecret } },
              ),
          }),
        },
      );
      expect(result.isError === true).toBe(status !== 200);
      expect(JSON.stringify(result)).not.toContain(backendSecret);
      expect(JSON.stringify(events)).not.toContain(backendSecret);
      expect(events).toHaveLength(1);
      expect(events[0]?.requestId).toBeUndefined();
      if (status === 200)
        expect(result.structuredContent).toEqual({
          data: { id: 1, name: 'Workspace' },
          request_id: null,
        });
    },
  );

  it('does not forward a configured secret supplied as an invocation request ID', async () => {
    let forwardedId: string | null = null;
    const result = await executeTool(
      'get_workspace',
      {},
      {
        resolveCredential: async () => workspaceToken,
        secrets: [backendSecret],
        clientFactory: createClientFactory({
          baseUrl: 'https://api.example.test',
          fetch: async (input, init) => {
            forwardedId = new Request(input, init).headers.get('X-Request-ID');
            return Response.json({ id: 1 });
          },
        }),
      },
      { requestId: backendSecret },
    );
    expect(result.isError).not.toBe(true);
    expect(forwardedId).toBeTruthy();
    expect(forwardedId).not.toBe(backendSecret);
    expect(JSON.stringify(result)).not.toContain(backendSecret);
  });

  it.each([
    { data: [{ description: `prefix ${workspaceToken} suffix` }] },
    { data: [{ [backendSecret]: 'value' }] },
    { data: { nested: [backendSecret] } },
    { data: { nested: [oauthToken] } },
    { data: { nested: [legacyToken] } },
    { data: { nested: ['quoted-"credential'] } },
  ])(
    'rejects credentials in decoded SDK payload keys and values: %#',
    async (data) => {
      const { events, onToolEvent } = telemetryCapture();
      const result = await executeTool(
        'get_workspace',
        {},
        {
          resolveCredential: async () => workspaceToken,
          secrets: [backendSecret, legacyToken, 'quoted-"credential'],
          onToolEvent,
          clientFactory: createClientFactory({
            baseUrl: 'https://api.example.test',
            fetch: async () => Response.json(data),
          }),
        },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain(
        'workspace_api_invalid_response',
      );
      for (const secret of [
        workspaceToken,
        backendSecret,
        oauthToken,
        legacyToken,
        'quoted-"credential',
      ]) {
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(events)).not.toContain(secret);
      }
    },
  );

  it('preserves normal workspace data and avoids short-secret substring collisions', async () => {
    const data = {
      id: 1,
      name: 'Table',
      sku: 'fab_table',
      description: 'Tokens represent quantities.',
      details: { nested: ['Safe workspace value', 3, true, null] },
    };
    const result = await executeTool(
      'get_workspace',
      {},
      {
        resolveCredential: async () => 'a',
        clientFactory: createClientFactory({
          baseUrl: 'https://api.example.test',
          fetch: async () => Response.json(data),
        }),
      },
    );
    expect(result.isError).not.toBe(true);
    expect(ToolResult.parse(result.structuredContent).data).toEqual(data);
  });

  it.each(['explicit', 'generated'] as const)(
    'rejects known and contract-shaped credentials in %s idempotency keys before a write',
    async (source) => {
      for (const secret of [legacyToken, backendSecret, oauthToken]) {
        let calls = 0;
        const key = `retry:${secret}:same-write`;
        const result = await executeTool(
          'create_product',
          {
            name: 'Desk',
            sku: 'D-1',
            unit: 'each',
            ...(source === 'explicit' ? { idempotency_key: key } : {}),
          },
          {
            resolveCredential: async () => legacyToken,
            secrets: [backendSecret],
            idempotencyKeyFactory: () => key,
            clientFactory: createClientFactory({
              baseUrl: 'https://api.example.test',
              fetch: async () => {
                calls++;
                return Response.json({ id: 1 });
              },
            }),
          },
        );
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain(
          'must not contain a Fabriqo credential',
        );
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(calls).toBe(0);
      }
    },
  );

  it('preserves ordinary fab-prefixed product SKUs and idempotency keys', async () => {
    const key = 'fab_product_creation_1';
    const result = await executeTool(
      'create_product',
      { name: 'Desk', sku: 'fab_table', unit: 'each', idempotency_key: key },
      {
        resolveCredential: async () => workspaceToken,
        clientFactory: createClientFactory({
          baseUrl: 'https://api.example.test',
          fetch: async () => Response.json({ id: 1, sku: 'fab_table' }),
        }),
      },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: { id: 1, sku: 'fab_table' },
      idempotency_key: key,
    });
  });

  it('preserves safe deliberate-retry guidance after rejecting a committed write response', async () => {
    let calls = 0;
    const result = await executeTool(
      'create_product',
      { name: 'Desk', sku: 'D-1', unit: 'each' },
      {
        resolveCredential: async () => workspaceToken,
        idempotencyKeyFactory: () => 'mcp:v1:credential-boundary',
        clientFactory: createClientFactory({
          baseUrl: 'https://api.example.test',
          fetch: async () => {
            calls++;
            return Response.json(
              { id: 1, description: workspaceToken },
              { status: 201 },
            );
          },
        }),
      },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(workspaceToken);
    expect(JSON.stringify(result)).toContain(
      'reuse idempotency key mcp:v1:credential-boundary',
    );
    expect(calls).toBe(1);
  });
});
