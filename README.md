# Fabriqo MCP

Official MCP server for Fabriqo.

Connect compatible AI clients to your Fabriqo workspace using the Model Context Protocol (MCP).

For setup guides and complete documentation, visit [docs.fabriqo.app](https://docs.fabriqo.app).

## Connect

Use the hosted Fabriqo MCP endpoint:

```text
https://mcp.fabriqo.app/mcp
```

The remote server uses OAuth to authenticate with Fabriqo. No local installation or API token is required.

## Local / stdio

For development or clients that require a local MCP server, set `FABRIQO_API_TOKEN` in your environment and run:

```sh
FABRIQO_API_BASE_URL=https://api.fabriqo.app npx -y @usefabriqo/mcp
```

The local server uses stdio and connects to Fabriqo through `@usefabriqo/sdk` using your API token. `FABRIQO_API_BASE_URL` is required; use the appropriate API origin for your environment.

## Capabilities

Fabriqo MCP provides tools for working with:

- products and materials
- suppliers and locations
- inventory and lots
- purchase and sales orders
- bills of materials
- production
- costing and forecasting
- traceability

Access is limited to the authenticated workspace and the permissions granted to the connection.

## Requirements

Local / stdio usage requires Node.js **22.18 or newer**.

Remote usage through `https://mcp.fabriqo.app/mcp` does not require Node.js or a local installation.

## Package

```sh
npm install @usefabriqo/mcp
```

The package is also available directly through `npx`:

```sh
npx -y @usefabriqo/mcp
```

## Development

```sh
npm ci
npm run check
```

## License

[MIT](LICENSE)
