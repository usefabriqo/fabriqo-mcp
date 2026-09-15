# Architecture

`fabriqo-mcp` is the official MCP server for Fabriqo.

It exposes an agent-oriented MCP interface while using the public [`@usefabriqo/sdk`](https://www.npmjs.com/package/@usefabriqo/sdk) for all Fabriqo business operations.

```text
MCP client
    ↓
fabriqo-mcp
    ↓
@usefabriqo/sdk
    ↓
Fabriqo API
```

The MCP server does not implement a second Fabriqo business API client. MCP input schemas and OAuth protocol validation live here; the SDK owns business API routes and request/response models.

## Responsibilities

The MCP layer owns:

- MCP tools and schemas
- tool descriptions and annotations
- tool-specific permission checks
- OAuth authentication and token exchange
- local stdio authentication
- MCP-specific result formatting
- MCP-specific error presentation
- transport and deployment security

`@usefabriqo/sdk` owns:

- Fabriqo API operations
- request serialization
- response decoding
- API authentication
- API errors
- response metadata
- read retries
- transport-level request controls

Business tools must use SDK resource methods rather than calling the Fabriqo API directly.

## Authentication

### Remote MCP

The hosted MCP server uses OAuth.

```text
MCP client
    ↓
Fabriqo OAuth access token
    ↓
token validation
    ↓
tool-specific scope check
    ↓
Workspace API token exchange
    ↓
@usefabriqo/sdk
```

The incoming MCP token is never forwarded directly to the Fabriqo API.

Each tool requests only the permission it requires.

The authenticated credential determines the Fabriqo workspace. Tools do not accept workspace IDs or workspace slugs.

### Local / stdio

Local stdio mode uses `FABRIQO_API_TOKEN` directly with `@usefabriqo/sdk`.

No OAuth exchange is required.

## Tools

The MCP tool surface is deliberately agent-oriented.

It is not generated directly from OpenAPI and does not expose every Fabriqo API operation automatically.

A tool may simplify, combine, or constrain underlying API operations when that produces a better interface for an AI client.

Tool input schemas are defined with Zod and remain independent from the SDK's generated request types.

## Results

Tools return structured MCP output alongside a text representation for compatible clients.

Read operations expose Fabriqo data and request metadata.

Idempotent mutations additionally expose the effective idempotency key and whether the operation was replayed.

## Idempotency

For supported mutations, the MCP generates a new opaque idempotency key when one is not supplied.

A deliberate retry must reuse both:

- the same idempotency key
- the same request payload

The MCP does not automatically retry writes.

## Pagination

MCP tools remain bounded.

Collection tools use cursor pagination and do not automatically drain complete datasets.

Nested collections with independent cursors remain independently paginated.

The MCP intentionally does not use SDK helpers such as `listAll` when that would make a tool unbounded.

## Errors

SDK errors are translated into safe MCP errors.

Useful information such as error codes, required permissions, request IDs, and retry hints may be preserved.

Credentials, backend implementation details, and other sensitive values must never be exposed through tool errors or logs.

## Transport

The hosted server uses stateless Streamable HTTP at:

```text
/mcp
```

Local mode uses stdio.

The remote service also exposes health, readiness, and OAuth protected-resource metadata endpoints required by the deployment and MCP authentication flow.

## Architectural guardrails

The repository includes automated architecture checks that prevent:

- sibling SDK source imports
- local SDK package dependencies
- handwritten Fabriqo `/v1/...` business routes
- direct `fetch()` calls from MCP business tools

`npm run check` also scans publishable working files, the Git index, and all locally available Git history for credential patterns and private files. The npm package is checked separately against an exact file allowlist. Pattern scanning supplements code review; it cannot establish ownership or detect every possible secret format.

These checks help preserve the boundary:

```text
Fabriqo API
    ↑
@usefabriqo/sdk
    ↑
fabriqo-mcp
```
