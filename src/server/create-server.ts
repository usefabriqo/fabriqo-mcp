import { type AuthInfo, McpServer } from '@modelcontextprotocol/server';
import { resolveWorkspaceToken } from '../auth/credentials.js';
import type { OAuthAuthorizationClient } from '../auth/oauth.js';
import type { Settings } from '../config/settings.js';
import { createTelemetry, type TelemetrySink } from '../observability/index.js';
import {
  createClientFactory,
  type FabriqoClientFactory,
} from '../sdk/client-factory.js';
import { registerTools } from '../tools/register-tools.js';

export const SERVER_INFO = {
  name: 'fabriqo',
  title: 'Fabriqo',
  version: '1.0.0',
  description:
    'Agent-oriented access to one Fabriqo workspace through Workspace API V1.',
};
export const SERVER_INSTRUCTIONS =
  'The bearer credential determines the workspace. Never ask for or pass a workspace ID or slug. Read tools never change state; write tools say so explicitly.';

export interface ServerOptions {
  mode: 'stdio' | 'http';
  authInfo?: AuthInfo;
  oauth?: OAuthAuthorizationClient;
  clientFactory?: FabriqoClientFactory;
  telemetry?: TelemetrySink;
}

export function createServer(
  settings: Settings,
  options: ServerOptions,
): McpServer {
  if (options.mode === 'stdio' && !settings.apiToken)
    throw new Error('FABRIQO_API_TOKEN is required for stdio transport.');
  const telemetry = createTelemetry(options.telemetry);
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    capabilities: { tools: {} },
  });
  const clientFactory =
    options.clientFactory ??
    createClientFactory({
      baseUrl: settings.apiBaseUrl,
      timeoutMs: settings.httpReadTimeoutSeconds * 1000,
      maxResponseBytes: settings.httpMaxResponseBytes,
      cfAccessClientId: settings.cfAccessClientId?.value(),
      cfAccessClientSecret: settings.cfAccessClientSecret?.value(),
    });
  registerTools(server, {
    clientFactory,
    resolveCredential: (scope, signal) =>
      resolveWorkspaceToken(
        options.mode === 'stdio'
          ? { mode: 'stdio' }
          : { mode: 'http', authInfo: options.authInfo },
        scope,
        settings,
        options.oauth,
        signal,
      ),
    secrets: [
      settings.apiToken?.value(),
      settings.oauthMcpBackendClientSecret?.value(),
      settings.cfAccessClientId?.value(),
      settings.cfAccessClientSecret?.value(),
      options.authInfo?.token,
    ].filter((value): value is string => !!value),
    onToolEvent: (event) =>
      telemetry({
        event: 'mcp_tool_call',
        tool: event.toolName,
        success: event.outcome === 'success',
        durationMs: event.durationMs,
        requestId: event.requestId,
        workspaceId:
          typeof options.authInfo?.extra?.workspace_id === 'number'
            ? options.authInfo.extra.workspace_id
            : undefined,
        actorUserId:
          typeof options.authInfo?.extra?.sub === 'string'
            ? options.authInfo.extra.sub
            : undefined,
      }),
  });
  return server;
}
