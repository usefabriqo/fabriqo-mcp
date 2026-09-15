#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadSettings } from './config/settings.js';
import { startHttp } from './server/http.js';
import { startStdio } from './server/stdio.js';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      host: { type: 'string' },
      port: { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: fabriqo-mcp [stdio|http] [--host 127.0.0.1] [--port 8002]\n\nDefault transport: stdio. HTTP uses Fabriqo OAuth and serves MCP at /mcp.\n',
    );
  } else {
    const mode = positionals[0] ?? 'stdio';
    if (positionals.length > 1 || !['stdio', 'http'].includes(mode))
      throw new Error('Use stdio or http.');
    const settings = loadSettings();
    if (mode === 'stdio') {
      const handle = startStdio(settings);
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          void handle.close().then(() => {
            process.exitCode = 0;
          });
        });
    } else {
      const port = Number(values.port ?? '8002');
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('The HTTP port must be between 1 and 65535.');
      const handle = startHttp(settings, { host: values.host, port });
      handle.server.once('error', () => {
        process.stderr.write('Fabriqo MCP HTTP listener could not start.\n');
        process.exitCode = 1;
      });
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          void handle.close().then(() => {
            process.exitCode = 0;
          });
        });
    }
  }
} catch {
  // Configuration/parser errors can contain user-supplied values. Never echo them.
  process.stderr.write(
    'Fabriqo MCP could not start. Check transport options and required environment variables (see README).\n',
  );
  process.exitCode = 1;
}
