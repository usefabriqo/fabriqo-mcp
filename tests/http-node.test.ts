import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { McpAuthFailureLimiter } from '../src/auth/abuse.js';
import {
  ACCESS_TOKEN_TYPE,
  OAuthAuthorizationClient,
} from '../src/auth/oauth.js';
import { MCP_SCOPES } from '../src/auth/scopes.js';
import {
  loadSettings,
  type TrustedClientIpMode,
} from '../src/config/settings.js';
import { createClientFactory } from '../src/sdk/client-factory.js';
import { startHttp } from '../src/server/http.js';

const MCP_TOKEN = `fqo_at_${'1'.repeat(24)}_${'m'.repeat(43)}`;
const API_TOKEN = `fqo_at_${'2'.repeat(24)}_${'a'.repeat(43)}`;
const PING = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
const environment = {
  FABRIQO_ENV: 'test',
  FABRIQO_API_BASE_URL: 'https://api.example.test',
  FABRIQO_MCP_PUBLIC_URL: 'https://mcp.example.test',
  FABRIQO_OAUTH_ISSUER_URL: 'https://auth.example.test',
  FABRIQO_OAUTH_INTROSPECTION_URL: 'https://auth.example.test/oauth/introspect',
  FABRIQO_OAUTH_TOKEN_URL: 'https://auth.example.test/oauth/token',
  FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID: 'mcp-test',
  FABRIQO_OAUTH_MCP_BACKEND_CLIENT_SECRET: 'backend-secret',
  FABRIQO_MCP_TRUSTED_HOSTS: '127.0.0.1',
  FABRIQO_MCP_MAX_REQUEST_BODY_BYTES: '1024',
  FABRIQO_MCP_AUTH_FAILURE_SOURCE_LIMIT: '1',
};

async function fixture(
  options: {
    trustedMode?: TrustedClientIpMode;
    bodyDeadlineMs?: number;
    apiFetch?: (request: Request) => Promise<Response>;
  } = {},
) {
  const settings = loadSettings({
    ...environment,
    FABRIQO_MCP_TRUSTED_CLIENT_IP_MODE: options.trustedMode ?? 'none',
  });
  const oauthRequests: Request[] = [];
  const apiRequests: Request[] = [];
  const sockets = new Set<Socket>();
  const limiter = new McpAuthFailureLimiter({
    sourceLimit: 1,
    windowSeconds: 60,
    maxSources: 8,
  });
  const oauth = new OAuthAuthorizationClient(settings, {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      oauthRequests.push(request);
      const body = new URLSearchParams(await request.text());
      if (request.url === settings.oauthIntrospectionUrl) {
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          active: true,
          token_type: 'Bearer',
          token_kind: 'mcp_access',
          scope: MCP_SCOPES.join(' '),
          client_id: 'node-test-client',
          sub: '7',
          aud: settings.mcpPublicUrl,
          iss: settings.oauthIssuerUrl,
          iat: now - 10,
          exp: now + 600,
          workspace_id: 41,
          oauth_grant_id: 9,
        });
      }
      return Response.json({
        access_token: API_TOKEN,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: 'Bearer',
        expires_in: 300,
        scope: body.get('scope') ?? '',
        resource: settings.apiBaseUrl,
      });
    },
  });
  const clientFactory = createClientFactory({
    baseUrl: settings.apiBaseUrl,
    maxRetries: 0,
    timeoutMs: 5000,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      apiRequests.push(request);
      return options.apiFetch
        ? options.apiFetch(request)
        : Response.json({ id: 41, name: 'Workspace', slug: 'workspace' });
    },
  });
  const hosted = startHttp(settings, {
    port: 0,
    oauth,
    clientFactory,
    authFailureLimiter: limiter,
    telemetry: () => {},
    bodyDeadlineMs: options.bodyDeadlineMs ?? 200,
  });
  await once(hosted.server, 'listening');
  const address = hosted.server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing loopback listener.');
  return {
    port: address.port,
    oauthRequests,
    apiRequests,
    limiter,
    async socket(): Promise<Socket> {
      const socket = connect({ host: '127.0.0.1', port: address.port });
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      await once(socket, 'connect');
      return socket;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      hosted.server.closeAllConnections();
      await hosted.close();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
interface RawResponse {
  status: number;
  headers: Headers;
  raw: string;
}

function requestHead(port: number, headers: string[], path = '/mcp'): string {
  return [
    `POST ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Connection: close',
    'Accept: application/json, text/event-stream',
    'Content-Type: application/json',
    'MCP-Protocol-Version: 2025-06-18',
    ...headers,
    '',
    '',
  ].join('\r\n');
}

async function rawExchange(
  f: Fixture,
  wire: string,
  onSocket?: (socket: Socket) => () => void,
): Promise<RawResponse> {
  const socket = await f.socket();
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    let cleanup = () => {};
    const timer = setTimeout(
      () => finish(new Error('Node test response timed out.')),
      2000,
    );
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      socket.destroy();
      if (error && !raw.startsWith('HTTP/1.1 ')) {
        reject(error);
        return;
      }
      const firstLine = raw.split('\r\n')[0] ?? '';
      const status = Number(firstLine.split(' ')[1]);
      if (!Number.isInteger(status) || status < 100) {
        reject(new Error(`No HTTP response received: ${firstLine}`));
        return;
      }
      const headers = new Headers();
      for (const line of raw
        .slice(0, raw.indexOf('\r\n\r\n'))
        .split('\r\n')
        .slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0)
          headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      resolve({ status, headers, raw });
    }
    socket.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
      // A stateless legacy reply may use SSE; consume its complete first message
      // and close like an MCP client instead of waiting for an idle stream EOF.
      if (
        /content-type: text\/event-stream/i.test(raw) &&
        /data: [^\r\n]+\r?\n\r?\n/.test(raw)
      )
        finish();
    });
    socket.once('end', () => finish());
    socket.once('error', (error) => finish(error));
    socket.once('close', () => finish());
    socket.write(wire);
    if (onSocket) cleanup = onSocket(socket);
  });
}

async function ping(
  f: Fixture,
  extraHeaders: string[] = [],
): Promise<RawResponse> {
  return rawExchange(
    f,
    requestHead(f.port, [
      `Authorization: Bearer ${MCP_TOKEN}`,
      `Content-Length: ${Buffer.byteLength(PING)}`,
      ...extraHeaders,
    ]) + PING,
  );
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Expected cancellation was not propagated.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('Node HTTP adversarial transport integration', () => {
  it('rejects raw duplicate Authorization fields before any introspection', async () => {
    const f = await fixture();
    try {
      const response = await rawExchange(
        f,
        requestHead(f.port, [
          `Authorization: Bearer ${MCP_TOKEN}`,
          'Authorization: Bearer attacker-second-credential',
          `Content-Length: ${Buffer.byteLength(PING)}`,
        ]) + PING,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.raw).not.toContain(MCP_TOKEN);
      expect(response.raw).not.toContain('attacker-second-credential');
      expect(f.oauthRequests).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it('uses one body deadline despite a slow drip, then refunds its source reservation', async () => {
    const f = await fixture({ bodyDeadlineMs: 60 });
    try {
      const response = await rawExchange(
        f,
        `${requestHead(f.port, [
          `Authorization: Bearer ${MCP_TOKEN}`,
          'Content-Length: 128',
        ])}{`,
        (socket) => {
          const interval = setInterval(() => socket.write(' '), 10);
          return () => clearInterval(interval);
        },
      );
      expect(response.status).toBe(408);
      expect(response.raw).toContain('request_body_timeout');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(f.oauthRequests).toHaveLength(0);
      expect(f.limiter.trackedSources).toEqual([]);
      expect((await ping(f)).status).toBe(200);
      expect(f.oauthRequests).toHaveLength(1);
      expect(f.limiter.trackedSources).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each(['content-length', 'chunked'] as const)(
    'enforces %s size limits before introspection',
    async (encoding) => {
      const f = await fixture();
      try {
        const body = 'x'.repeat(1025);
        const wire =
          encoding === 'content-length'
            ? requestHead(f.port, [
                `Authorization: Bearer ${MCP_TOKEN}`,
                'Content-Length: 1025',
              ])
            : `${requestHead(f.port, [
                `Authorization: Bearer ${MCP_TOKEN}`,
                'Transfer-Encoding: chunked',
              ])}${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
        const response = await rawExchange(f, wire);
        expect(response.status).toBe(413);
        expect(response.raw).toContain('request_body_too_large');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(f.oauthRequests).toHaveLength(0);
        expect(f.limiter.trackedSources).toEqual([]);
        expect((await ping(f)).status).toBe(200);
      } finally {
        await f.close();
      }
    },
  );

  it.each(['fly', 'cloudflare'] as const)(
    'rejects missing/duplicate configured %s identity headers with the public error contract',
    async (mode) => {
      const f = await fixture({ trustedMode: mode });
      const header = mode === 'fly' ? 'Fly-Client-IP' : 'CF-Connecting-IP';
      try {
        for (const extra of [
          [],
          [`${header}: 198.51.100.1`, `${header}: 198.51.100.2`],
        ]) {
          const response = await ping(f, extra);
          expect(response.status).toBe(400);
          expect(response.raw).toContain('"code":"mcp_client_ip_invalid"');
          expect(response.raw).toContain('"retryable":false');
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(response.headers.get('pragma')).toBe('no-cache');
        }
        expect(f.oauthRequests).toHaveLength(0);
        expect((await ping(f, [`${header}: 198.51.100.1`])).status).toBe(200);
        expect(f.oauthRequests).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );

  it('propagates caller disconnection to an in-flight SDK request', async () => {
    let entered!: (request: Request) => void;
    const started = new Promise<Request>((resolve) => {
      entered = resolve;
    });
    let release!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      apiFetch: (request) => {
        entered(request);
        return pendingResponse;
      },
    });
    try {
      const socket = await f.socket();
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_workspace', arguments: {} },
      });
      socket.write(
        requestHead(f.port, [
          `Authorization: Bearer ${MCP_TOKEN}`,
          `Content-Length: ${Buffer.byteLength(body)}`,
        ]) + body,
      );
      const apiRequest = await within(started, 1000);
      expect(apiRequest.headers.get('authorization')).toBe(
        `Bearer ${API_TOKEN}`,
      );
      const aborted = new Promise<void>((resolve) => {
        if (apiRequest.signal.aborted) resolve();
        else
          apiRequest.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
      socket.destroy();
      await within(aborted, 500);
      expect(apiRequest.signal.aborted).toBe(true);
    } finally {
      release(Response.json({ id: 41, name: 'Workspace' }));
      await f.close();
    }
  });
});
