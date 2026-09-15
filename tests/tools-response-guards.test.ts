import { describe, expect, it } from 'vitest';
import { createClientFactory } from '../src/sdk/client-factory.js';
import { executeTool, type ToolName } from '../src/tools/register-tools.js';

const product = { name: 'Desk', sku: 'D-1', unit: 'each' };
const invoke = (
  name: ToolName,
  fetch: typeof globalThis.fetch,
  limits: { timeoutMs?: number; maxResponseBytes?: number } = {},
  signal?: AbortSignal,
) =>
  executeTool(
    name,
    name === 'create_product' ? product : {},
    {
      clientFactory: createClientFactory({
        baseUrl: 'https://api.example.test',
        fetch,
        ...limits,
      }),
      resolveCredential: async () => 'workspace-token',
      idempotencyKeyFactory: () => 'mcp:v1:bounded-response',
    },
    { signal, requestId: 'bounded-request' },
  );

describe('SDK response byte/deadline safeguards', () => {
  it.each([200, 201])(
    'rejects empty successful HTTP %i responses before SDK empty-object decoding',
    async (status) => {
      let calls = 0;
      const result = await invoke(
        status === 201 ? 'create_product' : 'get_workspace',
        async () => {
          calls += 1;
          return new Response(null, {
            status,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': '0',
            },
          });
        },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        'workspace_api_invalid_response',
      );
      expect(calls).toBe(1);
      if (status === 201)
        expect(JSON.stringify(result)).toContain(
          'reuse idempotency key mcp:v1:bounded-response',
        );
    },
  );

  it('rejects binary SDK values instead of mistaking a Blob for an empty deletion acknowledgement', async () => {
    const clientFactory = createClientFactory({
      baseUrl: 'https://api.example.test',
      fetch: async () =>
        new Response(new Uint8Array([1, 2]), {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    });
    const result = await executeTool(
      'remove_bom_component',
      { bom_component_id: 7 },
      { clientFactory, resolveCredential: async () => 'workspace-token' },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('workspace_api_invalid_response');
  });

  it('decodes mislabeled success bodies through the SDK', async () => {
    const result = await invoke(
      'get_workspace',
      async () =>
        new Response('{"id":1}', { headers: { 'Content-Type': 'text/plain' } }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      data: { id: 1 },
      request_id: 'bounded-request',
    });
  });

  it.each(['get_workspace', 'create_product'] as const)(
    '%s caps unknown-length streamed responses without retry',
    async (name) => {
      let calls = 0;
      let cancelled = false;
      const result = await invoke(
        name,
        async () => {
          calls += 1;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"data":"'));
              },
              pull(controller) {
                controller.enqueue(new Uint8Array(32));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        },
        { maxResponseBytes: 16 },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        'workspace_api_response_too_large',
      );
      expect(JSON.stringify(result)).toContain('Request ID: bounded-request');
      expect(calls).toBe(1);
      expect(cancelled).toBe(true);
      if (name === 'create_product')
        expect(JSON.stringify(result)).toContain(
          'reuse idempotency key mcp:v1:bounded-response',
        );
    },
  );

  it.each([200, 400, 503])(
    'caps declared lengths for HTTP %i before SDK error parsing/retries',
    async (status) => {
      let calls = 0;
      const result = await invoke(
        'get_workspace',
        async () => {
          calls += 1;
          return new Response('{}', {
            status,
            headers: {
              'Content-Length': '1000',
              'X-Request-ID': 'large-upstream',
            },
          });
        },
        { maxResponseBytes: 10 },
      );
      expect(JSON.stringify(result)).toContain(
        'workspace_api_response_too_large',
      );
      expect(JSON.stringify(result)).toContain('Request ID: large-upstream');
      expect(calls).toBe(1);
    },
  );

  it.each(['get_workspace', 'create_product'] as const)(
    '%s deadline includes a slow body after headers arrive',
    async (name) => {
      let calls = 0;
      let cancelled = false;
      const result = await invoke(
        name,
        async () => {
          calls += 1;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{'));
              },
              // Never deliver another byte; this models a stalled upstream body.
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: {
                'Content-Type': 'application/json',
                'X-Request-ID': 'slow-body',
              },
            },
          );
        },
        { timeoutMs: 20 },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('workspace_api_request_timeout');
      expect(JSON.stringify(result)).toContain('Request ID: slow-body');
      expect(cancelled).toBe(true);
      expect(calls).toBe(1);
    },
  );

  it('deadline also bounds fetch implementations that fail to honor AbortSignal', async () => {
    const result = await invoke(
      'get_workspace',
      () => new Promise<Response>(() => {}),
      { timeoutMs: 20 },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('workspace_api_request_timeout');
  });

  it('deadline includes the SDK read retry backoff', async () => {
    let calls = 0;
    const started = performance.now();
    const result = await invoke(
      'get_workspace',
      async () => {
        calls += 1;
        return Response.json(
          { error: { code: 'rate_limited', message: 'Try later.' } },
          { status: 429, headers: { 'Retry-After': '5' } },
        );
      },
      { timeoutMs: 20 },
    );
    expect(result.isError).toBe(true);
    expect(calls).toBe(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('caller cancellation aborts pending body consumption', async () => {
    const controller = new AbortController();
    let cancelled = false;
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = invoke(
      'create_product',
      async () => {
        const response = new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
        );
        started?.();
        return response;
      },
      { timeoutMs: 10_000 },
      controller.signal,
    );
    await ready;
    // Let the decorator acquire the body reader before aborting.
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error('private reason must not appear'));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private reason');
    expect(JSON.stringify(result)).toContain('workspace_api_request_cancelled');
    expect(cancelled).toBe(true);
  });

  it('accepts exactly the cap, preserves response data, and allows empty 204', async () => {
    const success = await invoke(
      'get_workspace',
      async () =>
        new Response('{"id":1}', {
          headers: { 'Content-Type': 'application/json' },
        }),
      { maxResponseBytes: 8 },
    );
    expect(success.isError).not.toBe(true);
    expect(success.structuredContent).toEqual({
      data: { id: 1 },
      request_id: 'bounded-request',
    });
    const clientFactory = createClientFactory({
      baseUrl: 'https://api.example.test',
      fetch: async () => new Response(null, { status: 204 }),
      maxResponseBytes: 1,
    });
    const removed = await executeTool(
      'remove_bom_component',
      { bom_component_id: 7 },
      { clientFactory, resolveCredential: async () => 'workspace-token' },
    );
    expect(removed.isError).not.toBe(true);
  });
});
