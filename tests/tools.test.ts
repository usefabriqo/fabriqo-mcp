import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { type Fabriqo, FabriqoError } from '@usefabriqo/sdk';
import { describe, expect, it } from 'vitest';
import { MutationToolResult, ToolResult } from '../src/schemas/index.js';
import {
  createClientFactory,
  type FabriqoClientFactory,
} from '../src/sdk/client-factory.js';
import {
  executeTool,
  registerTools,
  type ToolDependencies,
  type ToolName,
  toolContract,
  toolNames,
  toolSchemas,
} from '../src/tools/register-tools.js';
import wireFixture from './fixtures/http-mapping.json' with { type: 'json' };
import mappingFixture from './fixtures/sdk-mapping.json' with { type: 'json' };
import contractFixture from './fixtures/tool-contract.json' with {
  type: 'json',
};

interface LegacySdkArguments {
  path?: Record<string, number>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  headers?: { 'Idempotency-Key': string };
}

/** Adapt the compatibility fixture's grouped arguments to public SDK methods. */
function registryArguments(args: readonly unknown[]): unknown[] {
  if (args.length !== 1) return [...args];
  const old = args[0] as LegacySdkArguments;
  if (!old.path && !old.query && !old.body) return [...args];
  return [
    ...Object.values(old.path ?? {}),
    ...(old.query ? [old.query] : []),
    ...(old.body ? [old.body] : []),
    ...(old.headers
      ? [{ idempotencyKey: old.headers['Idempotency-Key'] }]
      : [{}]),
  ];
}

function expectedHttpInput(
  fixture: (typeof mappingFixture.cases)[number],
): LegacySdkArguments {
  // Product convenience methods already used positional signatures in the original fixture.
  if (fixture.name === 'list_products')
    return { query: fixture.args[0] as Record<string, unknown> };
  if (fixture.name === 'create_product')
    return {
      body: fixture.args[0] as Record<string, unknown>,
      headers: {
        'Idempotency-Key': (fixture.args[1] as { idempotencyKey: string })
          .idempotencyKey,
      },
    };
  if (fixture.name === 'update_product')
    return { body: fixture.args[1] as Record<string, unknown> };
  if (fixture.name === 'get_product') return {};
  return fixture.args[0] as LegacySdkArguments;
}

function fakeBoundary(
  options: { data?: unknown; status?: number; error?: unknown } = {},
) {
  const calls: { operation: string; args: unknown[] }[] = [];
  const credentials: string[] = [];
  const scopes: (string | undefined)[] = [];
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => {}, {
      get: (_target, property) => proxy([...path, String(property)]),
      apply: async (_target, _receiver, args: unknown[]) => {
        calls.push({
          operation: path.join('.'),
          args: JSON.parse(JSON.stringify(args)) as unknown[],
        });
        if (options.error) throw options.error;
        return Object.hasOwn(options, 'data') ? options.data : { id: 101 };
      },
    });
  const clientFactory: FabriqoClientFactory = (token) => {
    credentials.push(token);
    return {
      client: proxy() as Fabriqo,
      metadata: {
        status: options.status ?? 201,
        requestId: 'upstream-request',
      },
    };
  };
  const dependencies: ToolDependencies = {
    clientFactory,
    resolveCredential: async (scope) => {
      scopes.push(scope);
      return 'workspace-test-credential';
    },
    idempotencyKeyFactory: () => 'mcp:v1:test-key',
  };
  return { dependencies, calls, credentials, scopes };
}

describe('MCP tool contract', () => {
  it('preserves all 45 exact names, descriptions, scopes, annotations and write kinds', () => {
    expect(toolNames).toHaveLength(45);
    expect(new Set(toolNames).size).toBe(45);
    expect(toolNames.map((name) => ({ name, ...toolContract[name] }))).toEqual(
      contractFixture.tools,
    );
    expect(
      toolNames.filter((name) => toolContract[name].kind === 'read'),
    ).toHaveLength(23);
    expect(
      toolNames.filter((name) => toolContract[name].kind === 'keyed'),
    ).toHaveLength(14);
    expect(
      toolNames.filter((name) => toolContract[name].kind === 'state'),
    ).toHaveLength(8);
    expect(
      new Set(
        toolNames.flatMap((name) => toolContract[name].requiredScope ?? []),
      ),
    ).toHaveLength(16);
  });

  it.each(mappingFixture.cases)(
    '$name calls the SDK method with normalized inputs',
    async (fixture) => {
      const boundary = fakeBoundary();
      const name = fixture.name as ToolName;
      const result = await executeTool(
        name,
        fixture.input,
        boundary.dependencies,
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(boundary.calls).toEqual([
        { operation: fixture.operation, args: registryArguments(fixture.args) },
      ]);
      expect(boundary.scopes).toEqual([
        toolContract[name].requiredScope ?? undefined,
      ]);
      expect(boundary.credentials).toEqual(['workspace-test-credential']);
      expect(
        (toolContract[name].kind === 'keyed'
          ? MutationToolResult
          : ToolResult
        ).safeParse(result.structuredContent).success,
      ).toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(result.structuredContent) },
      ]);
    },
  );

  it.each(mappingFixture.cases)(
    '$name preserves the expected HTTP request through the installed registry SDK',
    async (fixture) => {
      const name = fixture.name as ToolName;
      const route = wireFixture.cases.find((item) => item.name === name)!;
      expect(route).toBeDefined();
      const calls: Request[] = [];
      const clientFactory = createClientFactory({
        baseUrl: 'https://api.example.test',
        maxRetries: 0,
        fetch: async (input, init) => {
          calls.push(new Request(input, init));
          const headers = { 'X-Request-ID': 'wire-response-request' };
          return route.method === 'DELETE'
            ? new Response(null, { status: 204, headers })
            : Response.json({ id: 101 }, { headers });
        },
      });
      const result = await executeTool(
        name,
        fixture.input,
        {
          clientFactory,
          resolveCredential: async () => 'workspace-fixture-credential',
          idempotencyKeyFactory: () => 'mcp:v1:test-key',
        },
        { requestId: 'wire-client-request' },
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(calls).toHaveLength(1);
      const request = calls[0]!;
      const url = new URL(request.url);
      const expected = expectedHttpInput(fixture);
      expect(request.method).toBe(route.method);
      expect(`${url.origin}${url.pathname}`).toBe(
        `https://api.example.test${route.path}`,
      );
      expect([...url.searchParams].sort()).toEqual(
        Object.entries(expected.query ?? {})
          .map(([key, value]) => [key, String(value)])
          .sort(),
      );
      const rawBody = await request.text();
      expect(rawBody ? JSON.parse(rawBody) : undefined).toEqual(expected.body);
      expect(request.headers.get('idempotency-key')).toBe(
        expected.headers?.['Idempotency-Key'] ?? null,
      );
      expect(request.headers.get('authorization')).toBe(
        'Bearer workspace-fixture-credential',
      );
      expect(request.headers.get('x-request-id')).toBe('wire-client-request');
      expect(
        (toolContract[name].kind === 'keyed'
          ? MutationToolResult
          : ToolResult
        ).parse(result.structuredContent).request_id,
      ).toBe('wire-response-request');
      expect(request.redirect).toBe('error');
      expect(request.credentials).toBe('omit');
    },
  );

  it('bounds every nested collection independently and preserves its cursor', async () => {
    const boundary = fakeBoundary();
    await executeTool(
      'get_purchase_order',
      {
        purchase_order_id: 2,
        line_limit: 3,
        line_cursor: 'line-next',
        overhead_limit: 4,
        overhead_cursor: 'overhead-next',
        receipt_limit: 5,
        receipt_cursor: 'receipt-next',
      },
      boundary.dependencies,
    );
    await executeTool(
      'trace_lot',
      {
        lot_id: 9,
        movements_limit: 6,
        movements_cursor: 'moves-next',
        production_links_limit: 7,
        production_links_cursor: 'production-next',
        order_links_limit: 8,
        order_links_cursor: 'orders-next',
      },
      boundary.dependencies,
    );
    expect(boundary.calls).toEqual([
      {
        operation: 'purchaseOrders.get',
        args: [
          2,
          {
            line_limit: 3,
            line_cursor: 'line-next',
            overhead_limit: 4,
            overhead_cursor: 'overhead-next',
            receipt_limit: 5,
            receipt_cursor: 'receipt-next',
          },
          {},
        ],
      },
      {
        operation: 'traceability.lots.get',
        args: [
          9,
          {
            movements_limit: 6,
            movements_cursor: 'moves-next',
            production_links_limit: 7,
            production_links_cursor: 'production-next',
            order_links_limit: 8,
            order_links_cursor: 'orders-next',
          },
          {},
        ],
      },
    ]);
  });

  it('selects product stock through the product convenience facade', async () => {
    const boundary = fakeBoundary();
    await executeTool(
      'get_inventory_stock',
      { item_type: 'product', item_id: 7, location_id: 3, lot_id: 4 },
      boundary.dependencies,
    );
    expect(boundary.calls).toEqual([
      {
        operation: 'products.stock.get',
        args: [7, { location_id: 3, lot_id: 4 }, {}],
      },
    ]);
  });

  it('rejects unknown fields before credential resolution or SDK invocation', async () => {
    const boundary = fakeBoundary();
    for (const name of toolNames) {
      const result = await executeTool(
        name,
        { workspace_id: 123 },
        boundary.dependencies,
      );
      expect(result.isError).toBe(true);
    }
    expect(boundary.scopes).toEqual([]);
    expect(boundary.calls).toEqual([]);
  });
});

describe('structured mutation results and idempotency', () => {
  const product = { name: 'Desk', sku: 'D-1', unit: 'each' };
  it('generates a fresh opaque key for each invocation regardless of JSON-RPC ID', async () => {
    const boundary = fakeBoundary();
    delete boundary.dependencies.idempotencyKeyFactory;
    const first = await executeTool(
      'create_product',
      product,
      boundary.dependencies,
      { requestId: 'same-id' },
    );
    const second = await executeTool(
      'create_product',
      product,
      boundary.dependencies,
      { requestId: 'same-id' },
    );
    const a = MutationToolResult.parse(first.structuredContent);
    const b = MutationToolResult.parse(second.structuredContent);
    expect(a.idempotency_key).toMatch(/^mcp:v1:[0-9a-f-]{36}$/);
    expect(a.idempotency_key).not.toBe(b.idempotency_key);
    expect(a.replayed).toBe(false);
  });

  it('preserves explicit keys and infers replay metadata from response status/body', async () => {
    for (const [data, status, replayed] of [
      [{ id: 1 }, 200, true],
      [{ id: 1, replayed: false }, 200, false],
      [{ id: 1, replayed: true }, 201, true],
    ] as const) {
      const boundary = fakeBoundary({ data, status });
      const result = await executeTool(
        'create_product',
        { ...product, idempotency_key: 'caller-replay-key' },
        boundary.dependencies,
      );
      expect(result.structuredContent).toEqual({
        data,
        request_id: 'upstream-request',
        idempotency_key: 'caller-replay-key',
        replayed,
      });
    }
  });

  it.each([
    'workspace-test-credential',
    'retry-workspace-test-credential-embedded',
    `retry-fqo_at_${'a'.repeat(24)}_${'B'.repeat(43)}-embedded`,
  ])('rejects credential-bearing keys without sending a write', async (key) => {
    const boundary = fakeBoundary();
    const result = await executeTool(
      'create_product',
      { ...product, idempotency_key: key },
      boundary.dependencies,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      'must not contain a Fabriqo credential',
    );
    expect(JSON.stringify(result)).not.toContain(key);
    expect(boundary.calls).toEqual([]);
  });

  it('returns the effective key after an ambiguous write failure without retrying', async () => {
    const boundary = fakeBoundary({ error: new TypeError('network lost') });
    const result = await executeTool(
      'create_product',
      product,
      boundary.dependencies,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      'reuse idempotency key mcp:v1:test-key; do not change the payload',
    );
    expect(boundary.calls).toHaveLength(1);
  });

  it.each([
    'key with spaces',
    'clé',
    'key\ninjected',
    'key\tword',
    'key\u007f',
    '🗝',
  ])(
    'rejects non-header-safe idempotency keys before an SDK call',
    async (key) => {
      const boundary = fakeBoundary();
      const result = await executeTool(
        'create_product',
        { ...product, idempotency_key: key },
        boundary.dependencies,
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('invalid_idempotency_key');
      expect(boundary.calls).toEqual([]);
    },
  );

  it('retains compatible whitespace trimming around an otherwise valid explicit key', async () => {
    const boundary = fakeBoundary();
    const result = await executeTool(
      'create_product',
      { ...product, idempotency_key: ' \tcaller-key\r\n' },
      boundary.dependencies,
    );
    expect(
      MutationToolResult.parse(result.structuredContent).idempotency_key,
    ).toBe('caller-key');
  });

  it('does not advise reusing a conflicting key', async () => {
    const boundary = fakeBoundary({
      error: new FabriqoError(new Response('', { status: 409 }), {
        error: {
          code: 'idempotency_key_reused',
          message: 'That key is bound to a different payload.',
        },
      }),
    });
    const result = await executeTool(
      'create_product',
      product,
      boundary.dependencies,
    );
    expect(JSON.stringify(result)).toContain('idempotency_key_reused');
    expect(JSON.stringify(result)).not.toContain('reuse idempotency key');
  });

  it('preserves response request metadata after invalid JSON in a committed write', async () => {
    let requests = 0;
    const clientFactory = createClientFactory({
      baseUrl: 'https://api.example.test',
      fetch: async () => {
        requests += 1;
        return new Response('{"truncated":', {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': 'invalid-body-request',
          },
        });
      },
    });
    const result = await executeTool('create_product', product, {
      clientFactory,
      resolveCredential: async () => 'workspace-token',
      idempotencyKeyFactory: () => 'mcp:v1:invalid-body',
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('workspace_api_invalid_response');
    expect(JSON.stringify(result)).toContain(
      'Request ID: invalid-body-request',
    );
    expect(JSON.stringify(result)).toContain(
      'reuse idempotency key mcp:v1:invalid-body',
    );
    expect(requests).toBe(1);
  });

  it('synthesizes the BOM removal acknowledgement for an SDK 204 result', async () => {
    const boundary = fakeBoundary({ data: undefined, status: 204 });
    const result = await executeTool(
      'remove_bom_component',
      { bom_component_id: 77 },
      boundary.dependencies,
    );
    expect(result.structuredContent).toEqual({
      data: { bom_component_id: 77, removed: true },
      request_id: 'upstream-request',
    });
  });

  it('ordinary state changes return no invented replay metadata', async () => {
    const boundary = fakeBoundary({
      data: { id: 4, status: 'ordered' },
      status: 200,
    });
    const result = await executeTool(
      'mark_purchase_order_ordered',
      { purchase_order_id: 4 },
      boundary.dependencies,
    );
    expect(result.structuredContent).toEqual({
      data: { id: 4, status: 'ordered' },
      request_id: 'upstream-request',
    });
  });

  it.each([null, undefined])(
    'does not treat malformed BOM removal success as acknowledgement',
    async (data) => {
      const boundary = fakeBoundary({ data, status: 200 });
      const result = await executeTool(
        'remove_bom_component',
        { bom_component_id: 77 },
        boundary.dependencies,
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        'workspace_api_invalid_response',
      );
    },
  );

  it('rejects malformed SDK success shapes and preserves deliberate retry guidance', async () => {
    const boundary = fakeBoundary({ data: ['unexpected'] });
    const result = await executeTool(
      'create_product',
      product,
      boundary.dependencies,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      'reuse idempotency key mcp:v1:test-key',
    );
  });
});

describe('SDK client lifetime and metadata', () => {
  it.each(['token with spaces', 'tokén', 'bad\nheader', 'bad\u007f', ''])(
    'rejects invalid Workspace API credentials before creating a request',
    (token) => {
      let requests = 0;
      const factory = createClientFactory({
        baseUrl: 'https://api.example.test',
        fetch: async () => {
          requests += 1;
          return Response.json({});
        },
      });
      expect(() => factory(token)).toThrow(
        'A Fabriqo Workspace API bearer credential is required.',
      );
      expect(requests).toBe(0);
    },
  );

  it('trims surrounding credential whitespace before giving the token to the SDK', async () => {
    let authorization: string | null = null;
    const factory = createClientFactory({
      baseUrl: 'https://api.example.test',
      fetch: async (input, init) => {
        authorization = new Request(input, init).headers.get('Authorization');
        return Response.json({});
      },
    });
    await factory(' \tworkspace-token\n').client.workspace.get();
    expect(authorization).toBe('Bearer workspace-token');
  });

  it('uses registry SDK public methods, preserves request IDs and status, and isolates simultaneous tokens', async () => {
    const calls: Request[] = [];
    const clientFactory = createClientFactory({
      baseUrl: 'https://api.example.test',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        await Promise.resolve();
        return Response.json(
          { id: 1 },
          {
            status: 200,
            headers: {
              'X-Request-ID': request.headers.get('X-Request-ID') ?? '',
            },
          },
        );
      },
    });
    const invoke = (token: string, requestId: string) =>
      executeTool(
        'create_product',
        { name: 'Desk', sku: 'D-1', unit: 'each' },
        { clientFactory, resolveCredential: async () => token },
        { requestId },
      );
    const results = await Promise.all([
      invoke('workspace-a-token', 'request-a'),
      invoke('workspace-b-token', 'request-b'),
    ]);
    expect(
      calls.map((request) => [
        request.headers.get('Authorization'),
        request.headers.get('X-Request-ID'),
      ]),
    ).toEqual([
      ['Bearer workspace-a-token', 'request-a'],
      ['Bearer workspace-b-token', 'request-b'],
    ]);
    expect(
      results.map(
        (result) =>
          MutationToolResult.parse(result.structuredContent).request_id,
      ),
    ).toEqual(['request-a', 'request-b']);
    expect(
      results.every(
        (result) => MutationToolResult.parse(result.structuredContent).replayed,
      ),
    ).toBe(true);
  });

  it('adds configured Access headers and replaces unsafe upstream request IDs', async () => {
    let request: Request | undefined;
    const factory = createClientFactory({
      baseUrl: 'https://api.example.test',
      cfAccessClientId: 'configured-client',
      cfAccessClientSecret: 'configured-secret',
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json(
          {},
          { headers: { 'X-Request-ID': 'workspace-secret-token' } },
        );
      },
    });
    const handle = factory('workspace-secret-token', { requestId: 'safe-id' });
    await handle.client.workspace.get();
    expect(request?.headers.get('CF-Access-Client-Id')).toBe(
      'configured-client',
    );
    expect(request?.headers.get('CF-Access-Client-Secret')).toBe(
      'configured-secret',
    );
    expect(request?.redirect).toBe('error');
    expect(request?.credentials).toBe('omit');
    expect(handle.metadata.requestId).toBe('safe-id');
  });
});

describe('native MCP registration', () => {
  it('advertises semantic schemas and returns safe structured results over the SDK transport', async () => {
    const boundary = fakeBoundary();
    const server = new McpServer({ name: 'fabriqo', version: 'test' });
    registerTools(server, boundary.dependencies);
    const client = new Client({ name: 'contract-test', version: '1' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const catalogue = await client.listTools();
      expect(catalogue.tools).toHaveLength(45);
      for (const tool of catalogue.tools) {
        const name = tool.name as ToolName;
        expect(tool.description).toBe(toolContract[name].description);
        expect(tool.annotations).toEqual(toolContract[name].annotations);
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.outputSchema).toBeDefined();
      }
      const result = await client.callTool({
        name: 'get_product',
        arguments: { product_id: 7 },
      });
      expect(ToolResult.safeParse(result.structuredContent).success).toBe(true);
      const secret = `fqo_at_${'a'.repeat(24)}_${'B'.repeat(43)}`;
      for (const parameters of [
        { name: secret, arguments: {} },
        { name: 'get_workspace', arguments: { [secret]: 1 } },
      ]) {
        const error = await client.callTool(parameters);
        expect(error.isError).toBe(true);
        expect(JSON.stringify(error)).not.toContain(secret);
      }
      expect(toolSchemas.list_products.parse({})).toMatchObject({ limit: 25 });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
