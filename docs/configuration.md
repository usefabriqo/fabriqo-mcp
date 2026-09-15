# Configuration

Fabriqo MCP supports two execution modes:

```text
Remote HTTP → OAuth
Local stdio → Fabriqo API token
```

Configuration is read from environment variables.

The package does not automatically load `.env` files. For local development, use your shell, secret manager, or Node's `--env-file` support.

Secrets must never be committed to the repository.

## Local / stdio

Local mode requires a Fabriqo API token:

```text
FABRIQO_API_TOKEN
```

The token determines the workspace used by the MCP server.

Example:

```sh
export FABRIQO_API_TOKEN="..."
export FABRIQO_API_BASE_URL="https://api.fabriqo.app"
npx -y @usefabriqo/mcp
```

`FABRIQO_API_BASE_URL` is required; there is no default API origin. Set it to the production, staging, or development API origin appropriate for your token.

## Remote HTTP

The hosted MCP server uses OAuth rather than a Workspace API token.

The public Fabriqo MCP endpoint is:

```text
https://mcp.fabriqo.app/mcp
```

Remote deployments require the MCP resource URL and Fabriqo OAuth endpoints to be configured.

Relevant settings include:

| Variable | Purpose |
| --- | --- |
| `FABRIQO_ENV` | Runtime environment |
| `FABRIQO_API_BASE_URL` | Fabriqo API origin |
| `FABRIQO_MCP_PUBLIC_URL` | Public MCP resource origin |
| `FABRIQO_OAUTH_ISSUER_URL` | Fabriqo OAuth issuer |
| `FABRIQO_OAUTH_INTROSPECTION_URL` | OAuth token introspection endpoint |
| `FABRIQO_OAUTH_TOKEN_URL` | OAuth token endpoint |
| `FABRIQO_OAUTH_MCP_BACKEND_CLIENT_ID` | Confidential MCP backend client ID |
| `FABRIQO_OAUTH_MCP_BACKEND_CLIENT_SECRET` | Confidential MCP backend secret |

The incoming MCP OAuth token is validated and exchanged for a separate Workspace API token before `@usefabriqo/sdk` is called.

The incoming MCP bearer must never be forwarded directly to the Fabriqo API.

## HTTP endpoint

The Streamable HTTP endpoint is:

```text
/mcp
```

Operational endpoints include:

```text
/healthz
/readyz
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

Health checks process liveness.

Readiness checks whether the configured runtime is ready to serve requests.

## Hosts and origins

Remote deployments validate HTTP hosts and browser origins.

Relevant settings include:

| Variable | Purpose |
| --- | --- |
| `FABRIQO_MCP_TRUSTED_HOSTS` | Hosts accepted by the MCP server |
| `FABRIQO_MCP_ALLOWED_ORIGINS` | Browser origins allowed to access the service |
| `FABRIQO_MCP_MAX_REQUEST_BODY_BYTES` | Maximum MCP HTTP request size |
| `FABRIQO_MCP_TRUSTED_CLIENT_IP_MODE` | Trusted proxy/client-IP mode |

Wildcard trust should not be used.

Forwarded client-IP headers are trusted only when the corresponding trusted proxy mode is explicitly configured.

## Authentication abuse protection

The remote server limits repeated invalid authentication attempts before they can create excessive OAuth introspection load.

The available controls include:

| Variable | Purpose |
| --- | --- |
| `FABRIQO_MCP_AUTH_FAILURE_SOURCE_LIMIT` | Authentication failures allowed per source/window |
| `FABRIQO_MCP_AUTH_FAILURE_WINDOW_SECONDS` | Failure-rate window |
| `FABRIQO_MCP_AUTH_FAILURE_MAX_SOURCES` | Maximum number of tracked source buckets |

These controls are deployment protections and do not change MCP tool permissions.

## Workspace API request limits

Fabriqo MCP uses `@usefabriqo/sdk` for Workspace API operations.

The MCP may apply additional invocation-level bounds to preserve service safety.

Relevant settings include:

| Variable | Purpose |
| --- | --- |
| `FABRIQO_MCP_HTTP_READ_TIMEOUT_SECONDS` | Maximum duration for an upstream invocation |
| `FABRIQO_MCP_HTTP_MAX_RESPONSE_BYTES` | Maximum upstream response size |

The SDK owns Workspace API request serialization, response decoding, errors, and eligible read retries.

The MCP does not add a generic Workspace API retry loop and never automatically retries writes.

## Cloudflare Access

When a staging deployment requires Cloudflare Access service credentials, configure:

```text
CF_ACCESS_CLIENT_ID
CF_ACCESS_CLIENT_SECRET
```

They must be supplied together.

Only server-configured credentials may be forwarded to the Workspace API.

Client-supplied Cloudflare Access headers must never be forwarded upstream.

These credentials are deployment infrastructure and are separate from Fabriqo OAuth credentials.

## Release metadata

A deployment may set:

```text
FABRIQO_APP_RELEASE
```

to identify the running release.

This value is operational metadata and must not contain secrets.

## Security

Keep all API tokens, OAuth client secrets, and infrastructure credentials in the deployment's secret store.

Do not place secrets in:

```text
Git
package.json
README examples
Docker images
npm packages
logs
```

Remote deployments should use HTTPS except for explicit loopback development environments.
