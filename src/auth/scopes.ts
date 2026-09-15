export const MCP_SCOPES = [
  'catalog:read',
  'catalog:write',
  'locations:read',
  'locations:write',
  'suppliers:read',
  'suppliers:write',
  'inventory:read',
  'inventory:write',
  'purchasing:read',
  'purchasing:write',
  'sales:read',
  'sales:write',
  'manufacturing:read',
  'manufacturing:write',
  'reports:read',
  'traceability:read',
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export const MCP_SCOPE_SET: ReadonlySet<string> = new Set(MCP_SCOPES);
