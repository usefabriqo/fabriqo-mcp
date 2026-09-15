import {
  type ServeStdioOptions,
  serveStdio,
} from '@modelcontextprotocol/server/stdio';
import { loadSettings, type Settings } from '../config/settings.js';
import { createServer, type ServerOptions } from './create-server.js';

export function startStdio(
  settings: Settings = loadSettings(),
  options: Omit<ServerOptions, 'mode'> & {
    transport?: ServeStdioOptions['transport'];
  } = {},
) {
  if (!settings.apiToken)
    throw new Error('FABRIQO_API_TOKEN is required for stdio transport.');
  return serveStdio(
    () => createServer(settings, { ...options, mode: 'stdio' }),
    {
      legacy: 'serve',
      transport: options.transport,
      onerror: () =>
        options.telemetry?.({ event: 'mcp_transport_error', success: false }),
    },
  );
}
