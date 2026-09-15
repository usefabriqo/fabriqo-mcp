import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { MCP_SCOPES } from '../src/auth/scopes.js';
import { loadSettings } from '../src/config/settings.js';
import { safeRequestId } from '../src/errors/index.js';
import { MutationToolResult, ToolResult } from '../src/schemas/index.js';
import { createClientFactory } from '../src/sdk/client-factory.js';
import { startStdio } from '../src/server/stdio.js';
import { toolNames } from '../src/tools/contract.js';

export interface SmokeSummary {
  mode: 'local' | 'remote';
  protocol: '2026-07-28';
  tools: number;
  workspaceRead: true;
  reads?: string[];
  missingAndInvalidBearer?: true;
  insufficientScope?: true;
  inputErrorNormalization?: true;
  upstreamErrorNormalization?: true;
  idempotentWrite?: true;
  requestIds?: true;
  skipped?: string[];
}

export class SmokeConfigurationError extends Error {}

export interface RemoteSmokeConfig {
  baseUrl: URL;
  oauthAccessToken: string;
  timeoutMs: number;
  resourceUrl: string;
  insufficientScopeToken?: string;
  missingProductId?: number;
  orderTool:
    | 'list_production_runs'
    | 'list_purchase_orders'
    | 'list_sales_orders'
    | 'none';
  write?: { workspaceId: number; sku: string; idempotencyKey: string };
}

export function remoteSmokeConfig(
  environment: NodeJS.ProcessEnv,
  allowProduction = false,
  enableWrite = false,
): RemoteSmokeConfig {
  const rawUrl = environment.FABRIQO_MCP_SMOKE_BASE_URL?.trim();
  const token = environment.FABRIQO_MCP_SMOKE_OAUTH_ACCESS_TOKEN?.trim();
  if (!rawUrl || !token)
    throw new SmokeConfigurationError(
      'Remote smoke requires FABRIQO_MCP_SMOKE_BASE_URL and FABRIQO_MCP_SMOKE_OAUTH_ACCESS_TOKEN.',
    );
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SmokeConfigurationError(
      'The smoke target must be an absolute MCP URL.',
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback =
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol !== 'https:' && !loopback) ||
    url.username ||
    url.password ||
    url.pathname !== '/mcp' ||
    url.search ||
    url.hash
  ) {
    throw new SmokeConfigurationError(
      'The smoke target must use HTTPS, or HTTP on loopback, at /mcp with no credentials, query, or fragment.',
    );
  }
  const production =
    hostname === 'mcp.fabriqo.app' || environment.FABRIQO_ENV === 'production';
  if (!allowProduction && production) {
    throw new SmokeConfigurationError(
      'Production smoke requires the explicit --allow-production flag.',
    );
  }
  if (token.startsWith('fab_') || /\s/.test(token)) {
    throw new SmokeConfigurationError(
      'Remote smoke requires an MCP OAuth access token, not a Workspace API key.',
    );
  }
  const insufficientScopeToken =
    environment.FABRIQO_MCP_SMOKE_INSUFFICIENT_SCOPE_TOKEN?.trim();
  if (
    insufficientScopeToken &&
    (insufficientScopeToken.startsWith('fab_') ||
      /\s/.test(insufficientScopeToken) ||
      insufficientScopeToken === token)
  )
    throw new SmokeConfigurationError(
      'The insufficient-scope fixture must be a different MCP OAuth access token.',
    );
  const resourceUrl =
    environment.FABRIQO_MCP_SMOKE_RESOURCE_URL?.trim() ?? url.origin;
  if (![url.origin, `${url.origin}/mcp`].includes(resourceUrl))
    throw new SmokeConfigurationError(
      'The OAuth resource must be the target origin or its /mcp URL.',
    );
  const orderTool =
    environment.FABRIQO_MCP_SMOKE_ORDER_TOOL ?? 'list_production_runs';
  if (
    ![
      'list_production_runs',
      'list_purchase_orders',
      'list_sales_orders',
      'none',
    ].includes(orderTool)
  )
    throw new SmokeConfigurationError(
      'The order read must be list_production_runs, list_purchase_orders, list_sales_orders, or none.',
    );
  const positiveId = (
    value: string | undefined,
    name: string,
  ): number | undefined => {
    if (value === undefined) return undefined;
    const id = Number(value);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(id))
      throw new SmokeConfigurationError(
        `${name} must be a positive safe integer.`,
      );
    return id;
  };
  const missingProductId = positiveId(
    environment.FABRIQO_MCP_SMOKE_MISSING_PRODUCT_ID,
    'The missing product fixture ID',
  );
  let write: RemoteSmokeConfig['write'];
  if (enableWrite) {
    if (
      production ||
      allowProduction ||
      environment.FABRIQO_MCP_SMOKE_WORKSPACE_KIND !== 'staging'
    )
      throw new SmokeConfigurationError(
        'Write smoke requires FABRIQO_MCP_SMOKE_WORKSPACE_KIND=staging and cannot run in production mode.',
      );
    const workspaceId = positiveId(
      environment.FABRIQO_MCP_SMOKE_WORKSPACE_ID,
      'The expected staging workspace ID',
    );
    const sku = environment.FABRIQO_MCP_SMOKE_PRODUCT_SKU ?? '';
    const idempotencyKey = environment.FABRIQO_MCP_SMOKE_IDEMPOTENCY_KEY ?? '';
    if (
      !workspaceId ||
      !/^mcp-smoke-[a-z0-9-]{1,80}$/.test(sku) ||
      !/^mcp-smoke:[a-z0-9-]{1,100}$/.test(idempotencyKey)
    )
      throw new SmokeConfigurationError(
        'Write smoke requires an explicit workspace ID, mcp-smoke- product SKU, and mcp-smoke: idempotency key.',
      );
    if (
      [token, insufficientScopeToken].some(
        (secret) =>
          secret && (sku.includes(secret) || idempotencyKey.includes(secret)),
      )
    )
      throw new SmokeConfigurationError(
        'Smoke fixtures must not contain credentials.',
      );
    write = { workspaceId, sku, idempotencyKey };
  }
  const timeoutSeconds = Number(
    environment.FABRIQO_MCP_SMOKE_TIMEOUT_SECONDS ?? '15',
  );
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds > 300
  ) {
    throw new SmokeConfigurationError(
      'Smoke timeout must be greater than zero and at most 300 seconds.',
    );
  }
  return {
    baseUrl: url,
    oauthAccessToken: token,
    timeoutMs: timeoutSeconds * 1000,
    resourceUrl,
    insufficientScopeToken,
    missingProductId,
    orderTool: orderTool as RemoteSmokeConfig['orderTool'],
    write,
  };
}

async function checkClient(
  client: Client,
  mode: SmokeSummary['mode'],
  config?: RemoteSmokeConfig,
): Promise<SmokeSummary> {
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name).sort();
  if (
    result.nextCursor ||
    names.length !== 45 ||
    new Set(names).size !== 45 ||
    JSON.stringify(names) !== JSON.stringify([...toolNames].sort())
  ) {
    throw new Error(
      'The MCP tool catalogue does not match the 45-tool contract.',
    );
  }
  const workspace = await client.callTool({
    name: 'get_workspace',
    arguments: {},
  });
  if (workspace.isError)
    throw new Error('The workspace read returned a tool error.');
  const { data, request_id: requestId } = ToolResult.parse(
    workspace.structuredContent,
  );
  if (
    !Number.isSafeInteger(data.id) ||
    Number(data.id) <= 0 ||
    typeof data.slug !== 'string' ||
    !data.slug.trim() ||
    typeof data.name !== 'string' ||
    !data.name.trim()
  ) {
    throw new Error('The workspace read returned an invalid identity.');
  }
  if (client.getProtocolEra() !== 'modern')
    throw new Error('The MCP client did not negotiate the modern protocol.');
  const summary: SmokeSummary = {
    mode,
    protocol: '2026-07-28',
    tools: names.length,
    workspaceRead: true,
  };
  if (config) {
    requireRequestId(requestId, config);
    if (config.write && data.id !== config.write.workspaceId)
      throw new Error(
        'The authenticated workspace does not match the explicit staging write fixture.',
      );
    await checkRemoteOperations(client, config, summary);
  }
  return summary;
}

function requireRequestId(value: unknown, config: RemoteSmokeConfig): void {
  if (
    !safeRequestId(value, [
      config.oauthAccessToken,
      config.insufficientScopeToken ?? '',
    ])
  )
    throw new Error('The tool response did not contain a safe request ID.');
}

function errorText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content ?? [])
    .flatMap((item) => (item.type === 'text' ? [item.text] : []))
    .join(' ');
}

async function checkRemoteOperations(
  client: Client,
  config: RemoteSmokeConfig,
  summary: SmokeSummary,
): Promise<void> {
  summary.reads = ['get_workspace'];
  summary.skipped = [];
  const readTools = [
    'list_products',
    'list_locations',
    ...(config.orderTool === 'none' ? [] : [config.orderTool]),
  ];
  for (const name of readTools) {
    const result = await client.callTool({ name, arguments: { limit: 1 } });
    if (result.isError)
      throw new Error('A representative remote read returned a tool error.');
    const read = ToolResult.parse(result.structuredContent);
    if (!Array.isArray(read.data.items))
      throw new Error(
        'A paginated remote read did not contain an items collection.',
      );
    requireRequestId(read.request_id, config);
    summary.reads.push(name);
  }
  if (config.orderTool === 'none')
    summary.skipped.push(
      'manufacturing/order read: explicitly disabled for this workspace',
    );
  const invalidInput = await client.callTool({
    name: 'get_product',
    arguments: { product_id: 0 },
  });
  if (
    !invalidInput.isError ||
    !errorText(invalidInput).includes('Invalid tool arguments.')
  )
    throw new Error('Invalid tool arguments were not normalized.');
  summary.inputErrorNormalization = true;
  if (config.missingProductId) {
    const missing = await client.callTool({
      name: 'get_product',
      arguments: { product_id: config.missingProductId },
    });
    const message = errorText(missing);
    const requestId = /Request ID: ([A-Za-z0-9][A-Za-z0-9._:-]{0,63})\.$/.exec(
      message,
    )?.[1];
    if (!missing.isError || !message.startsWith('Fabriqo resource not found ['))
      throw new Error(
        'The missing-product fixture did not return a normalized not-found error.',
      );
    requireRequestId(requestId, config);
    summary.upstreamErrorNormalization = true;
  } else
    summary.skipped.push(
      'upstream error normalization: missing-product fixture ID unavailable',
    );
  if (config.write) {
    const args = {
      name: 'MCP staging release smoke fixture',
      sku: config.write.sku,
      unit: 'each',
      status: 'draft',
      idempotency_key: config.write.idempotencyKey,
    };
    const first = await client.callTool({
      name: 'create_product',
      arguments: args,
    });
    if (first.isError)
      throw new Error(
        'The staging write failed; inspect its fixed fixture key before deliberately retrying.',
      );
    const created = MutationToolResult.parse(first.structuredContent);
    requireRequestId(created.request_id, config);
    if (
      !Number.isSafeInteger(created.data.id) ||
      Number(created.data.id) < 1 ||
      created.idempotency_key !== config.write.idempotencyKey
    )
      throw new Error(
        'The staging write did not return an identity and the supplied idempotency key.',
      );
    // This is an explicit replay of a successful call. Failed writes are never retried.
    const second = await client.callTool({
      name: 'create_product',
      arguments: args,
    });
    if (second.isError)
      throw new Error('The deliberate staging idempotency replay failed.');
    const replayed = MutationToolResult.parse(second.structuredContent);
    requireRequestId(replayed.request_id, config);
    if (
      replayed.data.id !== created.data.id ||
      !replayed.replayed ||
      replayed.idempotency_key !== config.write.idempotencyKey
    )
      throw new Error(
        'The staging write replay did not preserve the resource and idempotency key.',
      );
    summary.idempotentWrite = true;
  } else
    summary.skipped.push(
      'idempotent write: --write and explicit staging fixtures not supplied',
    );
  summary.requestIds = true;
}

/** Real stdio framing and SDK invocation, with no network listeners or credentials. */
export async function runLocalSmoke(): Promise<SmokeSummary> {
  const input = new PassThrough();
  const output = new PassThrough();
  const token = 'fab_test_local-smoke-fixture';
  const settings = loadSettings({
    FABRIQO_ENV: 'test',
    FABRIQO_API_TOKEN: token,
    FABRIQO_API_BASE_URL: 'https://api.example.test',
  });
  const requests: Request[] = [];
  const clientFactory = createClientFactory({
    baseUrl: settings.apiBaseUrl,
    maxRetries: 0,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      requests.push(request);
      if (request.headers.get('authorization') !== `Bearer ${token}`)
        throw new Error('The local SDK credential was not preserved.');
      return Response.json(
        { id: 1, slug: 'local-smoke', name: 'Local smoke fixture' },
        { headers: { 'X-Request-ID': 'smoke-fixture' } },
      );
    },
  });
  const server = startStdio(settings, {
    clientFactory,
    telemetry: () => {},
    transport: new StdioServerTransport(input, output),
  });
  const client = new Client(
    { name: 'fabriqo-mcp-smoke', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await client.connect(new StdioServerTransport(output, input));
    const summary = await checkClient(client, 'local');
    if (requests.length !== 1)
      throw new Error('The local smoke expected one bounded SDK operation.');
    return summary;
  } finally {
    await client.close();
    await server.close();
    input.destroy();
    output.destroy();
  }
}

/** Remote reads, plus an explicit staging fixture write; requests reject redirects and have deadlines. */
export async function runRemoteSmoke(
  config: RemoteSmokeConfig,
): Promise<SmokeSummary> {
  const smokeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== config.baseUrl.origin)
      throw new Error('The smoke request changed origin.');
    return fetch(request, {
      redirect: 'error',
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(config.timeoutMs),
      ]),
    });
  };
  for (const [path, status] of [
    ['/healthz', 'ok'],
    ['/readyz', 'ready'],
  ] as const) {
    const response = await smokeFetch(new URL(path, config.baseUrl));
    if (response.status !== 200)
      throw new Error('An MCP operational probe failed.');
    const body = (await response.json()) as {
      status?: unknown;
      surface?: unknown;
    };
    if (body.status !== status || body.surface !== 'mcp')
      throw new Error('An MCP operational probe returned an unexpected body.');
  }
  const metadataResponse = await smokeFetch(
    new URL('/.well-known/oauth-protected-resource', config.baseUrl),
  );
  if (metadataResponse.status !== 200)
    throw new Error('The MCP resource metadata is unavailable.');
  const metadata = (await metadataResponse.json()) as {
    resource?: unknown;
    scopes_supported?: unknown;
    authorization_servers?: unknown;
  };
  if (
    metadata.resource !== config.resourceUrl ||
    JSON.stringify(metadata.scopes_supported) !== JSON.stringify(MCP_SCOPES) ||
    !Array.isArray(metadata.authorization_servers) ||
    metadata.authorization_servers.length === 0
  ) {
    throw new Error(
      'The MCP resource metadata does not match the public contract.',
    );
  }
  // A well-formed random invalid bearer reaches real OAuth introspection.
  const invalidToken = `fqo_at_${randomBytes(12).toString('hex')}_${randomBytes(32).toString('base64url')}`;
  for (const token of [undefined, invalidToken]) {
    const challenge = await smokeFetch(config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'challenge', method: 'ping' }),
    });
    if (
      challenge.status !== 401 ||
      !challenge.headers.get('www-authenticate')?.includes('resource_metadata=')
    )
      throw new Error(
        'An unauthenticated or invalid bearer did not produce the MCP OAuth challenge.',
      );
    await challenge.body?.cancel();
  }
  const legacyRoute = await smokeFetch(new URL('/', config.baseUrl), {
    method: 'POST',
  });
  if (legacyRoute.status !== 404 || legacyRoute.headers.has('location'))
    throw new Error('The retired root MCP route unexpectedly exists.');
  await legacyRoute.body?.cancel();
  const client = new Client(
    { name: 'fabriqo-mcp-smoke', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StreamableHTTPClientTransport(config.baseUrl, {
    fetch: smokeFetch,
    requestInit: {
      headers: { Authorization: `Bearer ${config.oauthAccessToken}` },
    },
  });
  try {
    await client.connect(transport);
    const summary = await checkClient(client, 'remote', config);
    summary.missingAndInvalidBearer = true;
    if (config.insufficientScopeToken) {
      const limited = new Client(
        { name: 'fabriqo-mcp-scope-smoke', version: '0.1.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      try {
        await limited.connect(
          new StreamableHTTPClientTransport(config.baseUrl, {
            fetch: smokeFetch,
            requestInit: {
              headers: {
                Authorization: `Bearer ${config.insufficientScopeToken}`,
              },
            },
          }),
        );
        const permitted = await limited.callTool({
          name: 'get_workspace',
          arguments: {},
        });
        if (permitted.isError)
          throw new Error(
            'The limited-scope fixture cannot authenticate and read its workspace.',
          );
        ToolResult.parse(permitted.structuredContent);
        const denied = await limited.callTool({
          name: 'list_products',
          arguments: { limit: 1 },
        });
        if (
          !denied.isError ||
          !errorText(denied).includes('[oauth_scope_required]') ||
          !errorText(denied).includes('catalog:read')
        )
          throw new Error(
            'The limited-scope fixture did not produce the expected catalog scope denial.',
          );
        summary.insufficientScope = true;
      } finally {
        await limited.close();
      }
    } else
      summary.skipped!.push(
        'insufficient OAuth scope: second restricted OAuth bearer unavailable',
      );
    return summary;
  } finally {
    await client.close();
  }
}

export async function main(
  args = process.argv.slice(2),
  environment = process.env,
): Promise<void> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        staging: { type: 'boolean' },
        'allow-production': { type: 'boolean' },
        write: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      process.stdout.write(
        'Usage: npm run smoke -- [--staging] [--allow-production] [--write]\nDefault: local stdio smoke with a mocked SDK boundary; no network calls.\nRemote: explicitly set FABRIQO_MCP_SMOKE_BASE_URL (ending /mcp) and FABRIQO_MCP_SMOKE_OAUTH_ACCESS_TOKEN.\nWrite: requires --staging and explicit staging workspace/SKU/idempotency fixtures.\n',
      );
      return;
    }
    if (values['allow-production'] && !values.staging)
      throw new SmokeConfigurationError(
        '--allow-production requires --staging remote mode.',
      );
    if (values.write && !values.staging)
      throw new SmokeConfigurationError(
        '--write requires --staging remote mode.',
      );
    const summary = values.staging
      ? await runRemoteSmoke(
          remoteSmokeConfig(
            environment,
            values['allow-production'],
            values.write,
          ),
        )
      : await runLocalSmoke();
    process.stdout.write(
      `[OK] ${summary.mode} MCP ${summary.protocol}: ${summary.tools} tools, structured workspace read.\n`,
    );
    if (summary.mode === 'remote')
      process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(
      error instanceof SmokeConfigurationError
        ? `[FAIL] ${error.message}\n`
        : '[FAIL] MCP smoke failed. Check the target configuration, OAuth permissions, and server logs.\n',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
