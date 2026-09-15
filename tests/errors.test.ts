import {
  FabriqoDecodingError,
  FabriqoError,
  FabriqoResponseTooLargeError,
  FabriqoTimeoutError,
  type ResponseMetadata,
} from '@usefabriqo/sdk';
import { describe, expect, it } from 'vitest';
import {
  normalizeError,
  presentToolError,
  redactText,
  SafeError,
  safeDetails,
  safeRequestId,
} from '../src/errors/index.js';

describe('agent-safe SDK errors', () => {
  it.each([401, 403])(
    'distinguishes gateway HTTP %s denial from a Workspace API credential failure',
    (status) => {
      for (const payload of [
        '<html>private gateway denial</html>',
        null,
        { error: 'gateway denied' },
        { error: { code: 'denied' } },
      ]) {
        const error = new FabriqoError(new Response(null, { status }), payload);
        expect(normalizeError(error)).toMatchObject({
          category: 'unavailable',
          code: 'workspace_api_authentication_unavailable',
          retryable: true,
        });
        expect(presentToolError(error)).not.toContain('gateway denial');
      }
    },
  );
  it.each([
    [409, true],
    [429, false],
  ] as const)(
    'retains explicit retryable metadata for HTTP %s',
    (status, retryable) => {
      const error = new FabriqoError(new Response(null, { status }), {
        error: {
          code: 'test_error',
          message: 'Public error',
          details: { retryable },
        },
      });
      expect(normalizeError(error).retryable).toBe(retryable);
    },
  );
  it.each([
    [400, 'validation'],
    [401, 'authentication'],
    [403, 'authorization'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'validation'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ] as const)('maps HTTP %s using SDK fields', (status, category) => {
    const error = new FabriqoError(
      new Response(null, {
        status,
        headers: { 'X-Request-ID': 'req-123', 'Retry-After': '3' },
      }),
      {
        error: {
          code: 'validation_error',
          message: 'safe field error',
          details: { field: 'name' },
        },
      },
    );
    const safe = normalizeError(error);
    expect(safe.category).toBe(category);
    expect(safe.requestId).toBe('req-123');
    const text = presentToolError(error, { requiredScope: 'inventory:write' });
    expect(text).toContain('Required Workspace API scope: inventory:write.');
    expect(text).toContain('Retry after 3 seconds.');
    if (status >= 500) expect(text).not.toContain('safe field error');
  });
  it.each([
    ['decoding', 'protocol', 'workspace_api_invalid_response'],
    ['oversize', 'response_too_large', 'workspace_api_response_too_large'],
  ] as const)(
    'preserves %s SDK errors without exposing raw response data or metadata',
    (kind, category, code) => {
      const secret = 'synthetic-response-credential';
      const metadata: ResponseMetadata = {
        status: 201,
        statusText: `private ${secret}`,
        requestId: 'safe-response-id',
        headers: new Headers({ 'Set-Cookie': `session=${secret}` }),
        url: `https://api.example.test/v1/products?token=${secret}`,
        method: 'POST',
        attempt: 1,
      };
      const error =
        kind === 'decoding'
          ? new FabriqoDecodingError(
              `unparseable response ${secret}`,
              metadata,
              new Error(`internal parser cause ${secret}`),
            )
          : new FabriqoResponseTooLargeError(1024, 1025, metadata);
      const safe = normalizeError(error, [secret]);
      expect(safe).toMatchObject({
        category,
        code,
        status: 201,
        requestId: 'safe-response-id',
        retryable: false,
      });
      expect(safe).not.toHaveProperty('cause');
      const text = presentToolError(error, {
        secrets: [secret],
        requiredScope: 'catalog:write',
        idempotencyKey: 'private-write-key',
      });
      expect(text).toContain('Request ID: safe-response-id.');
      expect(text).toContain('Required Workspace API scope: catalog:write.');
      expect(text).toContain('same idempotency key and the exact same payload');
      for (const privateValue of [
        secret,
        'private-write-key',
        'unparseable response',
        'internal parser cause',
        metadata.url,
      ]) {
        expect(text).not.toContain(privateValue);
        expect(JSON.stringify(safe)).not.toContain(privateValue);
      }
      const unsafeMetadata = { ...metadata, requestId: secret };
      const unsafeError =
        kind === 'decoding'
          ? new FabriqoDecodingError('', unsafeMetadata, undefined)
          : new FabriqoResponseTooLargeError(1024, 1025, unsafeMetadata);
      expect(normalizeError(unsafeError, [secret]).requestId).toBeUndefined();
      expect(
        presentToolError(unsafeError, { secrets: [secret] }),
      ).not.toContain(secret);
    },
  );
  it('normalizes the SDK total timeout and retains deliberate write retry guidance', () => {
    const error = new FabriqoTimeoutError(20_000);
    expect(normalizeError(error)).toMatchObject({
      category: 'unavailable',
      code: 'workspace_api_request_timeout',
      retryable: true,
    });
    const text = presentToolError(error, {
      idempotencyKey: 'private-timeout-key',
    });
    expect(text).toContain('This failure is retryable with backoff.');
    expect(text).toContain('same idempotency key and the exact same payload');
    expect(text).not.toContain('private-timeout-key');
    expect(text).not.toContain(error.message);
  });
  it('redacts every credential-bearing field and known secret without exposing backend internals', () => {
    const secret = 'private-client-credential';
    const details = Object.fromEntries(
      [
        'Authorization',
        'cookie',
        'credential',
        'idempotency_key',
        'password',
        'secret',
        'token',
      ].map((key) => [key, 'unrecognized secret']),
    );
    expect(Object.values(safeDetails(details) as object)).toEqual(
      Array(7).fill('[redacted]'),
    );
    const error = new FabriqoError(
      new Response(null, { status: 422, headers: { 'X-Request-ID': secret } }),
      {
        error: {
          code: secret,
          message: `bad ${secret} token=anothersecret`,
          details,
        },
      },
    );
    expect(presentToolError(error, { secrets: [secret] })).not.toContain(
      secret,
    );
    expect(presentToolError(error, { secrets: [secret] })).not.toContain(
      'anothersecret',
    );
    expect(safeRequestId(secret, [secret])).toBeUndefined();
    expect(redactText(`Bearer ${secret}`)).not.toContain(secret);
  });
  it('handles unexpected errors without echoing their messages', () => {
    for (const value of [
      undefined,
      null,
      new Error('private internals'),
      { message: 'private internals' },
      '<html>private internals',
    ]) {
      expect(normalizeError(value).category).toBe('protocol');
      expect(presentToolError(value)).not.toContain('private internals');
    }
    expect(normalizeError(new TypeError('network details')).category).toBe(
      'unavailable',
    );
  });
  it.each(['credential', 'response_too_large', 'client_closed'] as const)(
    'retains infrastructure category %s',
    (category) => {
      expect(
        normalizeError(
          new SafeError({
            category,
            code: 'safe_code',
            message: 'Public message',
          }),
        ).category,
      ).toBe(category);
    },
  );
  it('gives deliberate retry guidance without revealing the idempotency key', () => {
    const message = presentToolError(new TypeError('connection lost'), {
      idempotencyKey: 'private-key',
    });
    expect(message).toContain(
      'same idempotency key and the exact same payload',
    );
    expect(message).not.toContain('private-key');
  });
});
