import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
} from '@modelcontextprotocol/server';
import type { Settings } from '../config/settings.js';
import { type OAuthAuthorizationClient, OAuthServerError } from './oauth.js';

export class CredentialError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CredentialError';
  }
}

export class WorkspaceTokenVerifier {
  constructor(
    readonly client: OAuthAuthorizationClient,
    readonly settings: Settings,
  ) {}

  async verifyToken(
    token: string,
    signal?: AbortSignal,
  ): Promise<AuthInfo | null> {
    const introspected = await this.client.introspectMcpToken(token, signal);
    if (!introspected) return null;
    return {
      token,
      clientId: introspected.clientId,
      scopes: introspected.scopes,
      expiresAt: introspected.expiresAt,
      resource: new URL(this.settings.mcpPublicUrl!),
      extra: { ...introspected.claims, sub: introspected.userId },
    };
  }

  /** Native MCP v2 OAuthTokenVerifier integration. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const authInfo = await this.verifyToken(token);
    if (!authInfo)
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        'Invalid access token.',
      );
    return authInfo;
  }
}

export type CredentialContext =
  | { mode: 'stdio' }
  | { mode: 'http'; authInfo?: AuthInfo };

/** HTTP callers must provide AuthInfo from the transport's verified auth context. */
export async function resolveWorkspaceToken(
  context: CredentialContext,
  requiredScope: string | null | undefined,
  settings: Settings,
  oauthClient?: OAuthAuthorizationClient,
  signal?: AbortSignal,
): Promise<string> {
  if (context.mode === 'stdio') {
    if (!settings.apiToken)
      throw new CredentialError(
        'workspace_api_credential_required',
        'Set FABRIQO_API_TOKEN for local stdio use.',
      );
    return settings.apiToken.value();
  }
  if (!context.authInfo)
    throw new CredentialError(
      'oauth_authentication_required',
      'Authenticate this Fabriqo MCP connection.',
    );
  if (!oauthClient)
    throw new CredentialError(
      'oauth_exchange_unavailable',
      'Fabriqo authentication is unavailable.',
    );
  if (requiredScope && !context.authInfo.scopes.includes(requiredScope))
    throw new CredentialError(
      'oauth_scope_required',
      `Reconnect with the required ${requiredScope} permission.`,
    );
  try {
    return await oauthClient.exchangeForWorkspaceApi(
      context.authInfo.token,
      requiredScope ? [requiredScope] : [],
      signal,
    );
  } catch (error) {
    if (!(error instanceof OAuthServerError)) throw error;
    if (error.reauthenticationRequired)
      throw new CredentialError(
        'oauth_reauthentication_required',
        'Reconnect the Fabriqo MCP server.',
      );
    throw new CredentialError(
      'oauth_exchange_unavailable',
      'Fabriqo authentication is temporarily unavailable.',
    );
  }
}

/** Only positive validated integer workspace claims are safe telemetry labels. */
export function workspaceIdFromAuthInfo(
  authInfo?: AuthInfo,
): string | undefined {
  const value = authInfo?.extra?.workspace_id;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : undefined;
}
