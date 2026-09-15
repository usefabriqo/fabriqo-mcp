import {
  createServer as createNodeServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  validateHostHeader,
  validateOriginHeader,
  verifyBearerToken,
} from '@modelcontextprotocol/server';
import {
  type AuthAttemptReservation,
  clientNetworkIdentity,
  InvalidTrustedClientIp,
  McpAuthFailureLimiter,
} from '../auth/abuse.js';
import { WorkspaceTokenVerifier } from '../auth/credentials.js';
import { OAuthAuthorizationClient, OAuthServerError } from '../auth/oauth.js';
import { MCP_SCOPES } from '../auth/scopes.js';
import {
  loadSettings,
  type Settings,
  validateRemoteOAuth,
} from '../config/settings.js';
import { normalizeError, SafeError, safeRequestId } from '../errors/index.js';
import { createTelemetry } from '../observability/index.js';
import { createServer, type ServerOptions } from './create-server.js';
import { createReadinessProbe } from './readiness.js';
import {
  REQUEST_BODY_DEADLINE_MS,
  RequestBodyError,
  readNodeBody,
  readWebBody,
} from './request-limits.js';

export interface HttpOptions extends Omit<ServerOptions, 'mode' | 'authInfo'> {
  authFailureLimiter?: McpAuthFailureLimiter;
  bodyDeadlineMs?: number;
  readinessProbe?: () => Promise<boolean>;
}

const noStore = { 'Cache-Control': 'no-store' };
function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(value, { status, headers: { ...noStore, ...headers } });
}
function bodyError(error: RequestBodyError): Response {
  return json(
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: error.message,
        data: { reason: error.reason },
      },
    },
    error.status,
    { Pragma: 'no-cache' },
  );
}
function nodeHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
  return headers;
}
async function sendResponse(
  response: Response,
  output: ServerResponse,
): Promise<void> {
  output.writeHead(response.status, Object.fromEntries(response.headers));
  output.end(new Uint8Array(await response.arrayBuffer()));
}

/** Stateless /mcp service. User credentials never persist in a shared SDK client. */
export function createHttpApp(
  settings: Settings = loadSettings(),
  options: HttpOptions = {},
) {
  validateRemoteOAuth(settings);
  const telemetry = createTelemetry(options.telemetry);
  const oauth = options.oauth ?? new OAuthAuthorizationClient(settings);
  const verifier = new WorkspaceTokenVerifier(oauth, settings);
  const limiter =
    options.authFailureLimiter ??
    new McpAuthFailureLimiter({
      sourceLimit: settings.authFailureSourceLimit,
      windowSeconds: settings.authFailureWindowSeconds,
      maxSources: settings.authFailureMaxSources,
    });
  const deadlineMs = options.bodyDeadlineMs ?? REQUEST_BODY_DEADLINE_MS;
  const readinessProbe =
    options.readinessProbe ??
    (['staging', 'production'].includes(settings.environment)
      ? createReadinessProbe(settings)
      : async () => true);
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(
    new URL(settings.mcpPublicUrl!),
  );
  const metadata = {
    ...buildOAuthProtectedResourceMetadata({
      oauthMetadata: {
        issuer: settings.oauthIssuerUrl!,
        authorization_endpoint: `${settings.oauthIssuerUrl}/oauth/authorize`,
        token_endpoint: settings.oauthTokenUrl!,
        response_types_supported: ['code'],
      },
      resourceServerUrl: new URL(settings.mcpPublicUrl!),
      scopesSupported: [...MCP_SCOPES],
    }),
    // Python advertises its canonical origin without a trailing slash.
    resource: settings.mcpPublicUrl!,
    bearer_methods_supported: ['header'],
  };
  let closed = false;
  const mcp = createMcpHandler(
    (context) =>
      createServer(settings, {
        ...options,
        mode: 'http',
        oauth,
        authInfo: context.authInfo,
      }),
    {
      legacy: 'stateless',
      responseMode: 'auto',
      onerror: () =>
        telemetry({ event: 'mcp_transport_error', success: false }),
    },
  );

  function security(headers: Headers): Response | undefined {
    if (
      /[\s\\/?#@,]/.test(headers.get('host') ?? '') ||
      !validateHostHeader(headers.get('host'), [...settings.trustedHosts]).ok
    )
      return json({ error: 'Invalid host header.' }, 400);
    const origin = headers.get('origin');
    if (
      origin !== null &&
      (!validateOriginHeader(
        origin,
        settings.allowedOrigins.map((value) => new URL(value).hostname),
      ).ok ||
        !settings.allowedOrigins.includes(origin))
    )
      return json({ error: 'Invalid Origin header.' }, 403);
    return undefined;
  }
  function reserve(
    headers: Headers,
    socketAddress?: string,
  ): AuthAttemptReservation | Response {
    let identity: string;
    try {
      identity = clientNetworkIdentity(
        headers,
        settings.trustedClientIpMode,
        socketAddress,
      );
    } catch (error) {
      if (error instanceof InvalidTrustedClientIp)
        return json(
          {
            error: {
              code: 'mcp_client_ip_invalid',
              message: error.message,
              retryable: false,
            },
          },
          400,
          { Pragma: 'no-cache' },
        );
      throw error;
    }
    const attempt = limiter.tryReserve(identity);
    return (
      attempt.reservation ??
      json(
        {
          error: {
            code: 'mcp_auth_rate_limited',
            message: 'Too many authentication failures.',
            retryable: true,
          },
        },
        429,
        { 'Retry-After': String(attempt.retryAfter ?? 1), Pragma: 'no-cache' },
      )
    );
  }
  function dependencyError(error: unknown): Response {
    if (error instanceof OAuthServerError) {
      const rateLimited = error.statusCode === 429;
      const headers: Record<string, string> = {};
      if (error.retryAfterSeconds !== undefined)
        headers['Retry-After'] = String(
          Math.max(0, Math.ceil(error.retryAfterSeconds)),
        );
      const requestId = safeRequestId(error.requestId);
      if (requestId) headers['X-Request-ID'] = requestId;
      return json(
        {
          error: {
            code: rateLimited
              ? 'oauth_backend_rate_limited'
              : 'oauth_backend_unavailable',
            message: 'Fabriqo authentication is temporarily unavailable.',
            retryable: true,
          },
        },
        rateLimited ? 429 : 503,
        headers,
      );
    }
    const safe = normalizeError(error);
    const rateLimited = safe.category === 'rate_limited';
    const headers: Record<string, string> = {};
    if (safe.retryAfterSeconds !== undefined)
      headers['Retry-After'] = String(Math.ceil(safe.retryAfterSeconds));
    if (safe.requestId) headers['X-Request-ID'] = safe.requestId;
    return json(
      {
        error: {
          code: safe.code,
          message: 'Fabriqo is temporarily unavailable.',
          retryable: true,
        },
      },
      rateLimited ? 429 : 503,
      headers,
    );
  }

  async function fetchHandler(
    request: Request,
    context: {
      socketAddress?: string;
      reservation?: AuthAttemptReservation;
    } = {},
  ): Promise<Response> {
    let reservation = context.reservation;
    let authFailed = false;
    try {
      const rejected = security(request.headers);
      if (rejected) return rejected;
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/healthz')
        return json({ status: 'ok', surface: 'mcp' });
      if (request.method === 'GET' && path === '/readyz') {
        const dependenciesReady =
          !closed && oauth.isStarted && (await readinessProbe());
        const ready = dependenciesReady && !closed && oauth.isStarted;
        return json(
          {
            status: ready ? 'ready' : 'not_ready',
            surface: 'mcp',
          },
          ready ? 200 : 503,
        );
      }
      if (
        path === '/.well-known/oauth-protected-resource' ||
        path === '/.well-known/oauth-protected-resource/mcp'
      )
        return request.method === 'GET'
          ? json(metadata)
          : json({ error: 'Method not allowed.' }, 405, { Allow: 'GET' });
      if (path !== '/mcp') return json({ error: 'Not found.' }, 404);
      if (!reservation) {
        const reserved = reserve(request.headers, context.socketAddress);
        if (reserved instanceof Response) return reserved;
        reservation = reserved;
      }
      if (closed)
        return json({ error: 'Fabriqo is temporarily unavailable.' }, 503);
      // Consume a bounded body before potentially expensive introspection.
      let body: Uint8Array | undefined;
      if (
        request.headers.has('authorization') &&
        !['GET', 'HEAD'].includes(request.method)
      )
        body = await readWebBody(
          request,
          settings.maxRequestBodyBytes,
          deadlineMs,
        );
      const authHeader = request.headers.get('authorization');
      let authInfo: AuthInfo;
      try {
        if (!authHeader || !/^Bearer [^\s]+$/i.test(authHeader))
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            'Authentication required',
          );
        authInfo = await verifyBearerToken(authHeader, {
          verifier: {
            verifyAccessToken: async (token) => {
              const auth = await verifier.verifyToken(token, request.signal);
              if (!auth)
                throw new OAuthError(
                  OAuthErrorCode.InvalidToken,
                  'Invalid access token.',
                );
              return auth;
            },
          },
          requiredScopes: [],
          resourceMetadataUrl: metadataUrl,
        });
      } catch (error) {
        telemetry({ event: 'mcp_authentication', success: false });
        if (error instanceof OAuthError) {
          authFailed = error.code === OAuthErrorCode.InvalidToken;
          const response = bearerAuthChallengeResponse(error, {
            resourceMetadataUrl: metadataUrl,
          });
          response.headers.set('Cache-Control', 'no-store');
          return response;
        }
        return dependencyError(error);
      }
      telemetry({
        event: 'mcp_authentication',
        success: true,
        workspaceId:
          typeof authInfo.extra?.workspace_id === 'number'
            ? authInfo.extra.workspace_id
            : undefined,
      });
      if (body)
        request = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: body as BodyInit,
          signal: request.signal,
        });
      const response = await mcp.fetch(request, { authInfo });
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } catch (error) {
      if (error instanceof RequestBodyError) return bodyError(error);
      if (error instanceof OAuthServerError || error instanceof SafeError)
        return dependencyError(error);
      telemetry({ event: 'mcp_transport_error', success: false });
      return json({ error: 'Fabriqo is temporarily unavailable.' }, 503);
    } finally {
      if (reservation) limiter.settle(reservation, authFailed);
    }
  }

  async function nodeHandler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let reservation: AuthAttemptReservation | undefined;
    try {
      const headers = nodeHeaders(request);
      const rejected = security(headers);
      if (rejected) {
        await sendResponse(rejected, response);
        return;
      }
      const path = new URL(request.url ?? '/', settings.mcpPublicUrl).pathname;
      if (path === '/mcp') {
        const reserved = reserve(headers, request.socket.remoteAddress);
        if (reserved instanceof Response) {
          await sendResponse(reserved, response);
          return;
        }
        reservation = reserved;
      }
      // The Node adapter buffers before calling fetch, so bound receipt here too.
      let body: Uint8Array = new Uint8Array();
      if (
        headers.has('authorization') &&
        !['GET', 'HEAD'].includes(request.method ?? 'GET')
      )
        body = await readNodeBody(
          request,
          settings.maxRequestBodyBytes,
          deadlineMs,
        );
      const boundedRequest = {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(headers),
        async *[Symbol.asyncIterator]() {
          if (body.length) yield body;
        },
      };
      await toNodeHandler(
        {
          fetch: (webRequest) =>
            fetchHandler(webRequest, {
              socketAddress: request.socket.remoteAddress,
              reservation,
            }),
        },
        {
          onerror: () =>
            telemetry({ event: 'mcp_transport_error', success: false }),
        },
      )(boundedRequest, response);
    } catch (error) {
      if (!response.headersSent) {
        response.setHeader('Connection', 'close');
        await sendResponse(
          error instanceof RequestBodyError
            ? bodyError(error)
            : json({ error: 'Request could not be processed.' }, 400),
          response,
        );
      }
    } finally {
      if (reservation) limiter.settle(reservation, false);
    }
  }

  return {
    fetch: fetchHandler,
    nodeHandler,
    async close() {
      closed = true;
      oauth.close();
      await mcp.close();
    },
  };
}

export function startHttp(
  settings: Settings = loadSettings(),
  options: HttpOptions & { host?: string; port?: number } = {},
) {
  const app = createHttpApp(settings, options);
  const server = createNodeServer((request, response) => {
    void app.nodeHandler(request, response);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(options.port ?? 8002, options.host ?? '127.0.0.1');
  return {
    app,
    server,
    async close() {
      await app.close();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
