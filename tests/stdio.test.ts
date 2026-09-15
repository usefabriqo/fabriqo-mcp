import { execFile } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { describe, expect, it, vi } from 'vitest';
import { remoteSmokeConfig, runLocalSmoke } from '../scripts/smoke.js';
import { loadSettings } from '../src/config/settings.js';
import { createClientFactory } from '../src/sdk/client-factory.js';
import { startStdio } from '../src/server/stdio.js';
import { toolNames } from '../src/tools/contract.js';

describe('native stdio', () => {
  it('requires a local workspace API credential before transport creation', () => {
    expect(() =>
      startStdio(
        loadSettings({
          FABRIQO_ENV: 'test',
          FABRIQO_API_BASE_URL: 'https://api.example.test',
        }),
      ),
    ).toThrow('FABRIQO_API_TOKEN');
  });

  it.each(['legacy', 'modern'] as const)(
    'supports the %s client handshake, tool listing and credentialed SDK read',
    async (era) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const token = 'fab_test_stdio-workspace';
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
          requests.push(new Request(url, init));
          return Response.json(
            { id: 7, slug: 'workshop', name: 'Workshop' },
            { headers: { 'X-Request-ID': 'stdio-request' } },
          );
        },
      });
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected network or OAuth operation.'));
      const server = startStdio(settings, {
        clientFactory,
        telemetry: () => {},
        transport: new StdioServerTransport(input, output),
      });
      const client = new Client(
        { name: 'stdio-test', version: '1' },
        {
          versionNegotiation: {
            mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy',
          },
        },
      );
      try {
        await client.connect(new StdioServerTransport(output, input));
        expect(client.getProtocolEra()).toBe(era);
        expect(client.getServerVersion()).toMatchObject({
          name: 'fabriqo',
          title: 'Fabriqo',
        });
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
          [...toolNames].sort(),
        );
        expect(tools.nextCursor).toBeUndefined();
        const result = await client.callTool({
          name: 'get_workspace',
          arguments: {},
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
          data: { id: 7, slug: 'workshop', name: 'Workshop' },
          request_id: 'stdio-request',
        });
        expect(result.content).toEqual([
          { type: 'text', text: JSON.stringify(result.structuredContent) },
        ]);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers.get('authorization')).toBe(
          `Bearer ${token}`,
        );
        expect(network).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
        input.destroy();
        output.destroy();
        network.mockRestore();
      }
    },
  );

  it('CLI startup failures leave stdout available exclusively for protocol traffic', async () => {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const result = await new Promise<{
      error: Error | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', cli],
        {
          env: {
            FABRIQO_ENV: 'test',
            FABRIQO_API_BASE_URL: 'https://api.example.test',
          },
        },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
    });
    expect(result.error).not.toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Fabriqo MCP could not start.');
  });
});

describe('smoke entry point', () => {
  it('runs locally through native stdio without credentials, sockets, or network calls', async () => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected network.'));
    try {
      expect(await runLocalSmoke()).toEqual({
        mode: 'local',
        protocol: '2026-07-28',
        tools: 45,
        workspaceRead: true,
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('requires an explicit remote endpoint and an MCP OAuth token', () => {
    expect(() => remoteSmokeConfig({})).toThrow('FABRIQO_MCP_SMOKE_BASE_URL');
    expect(() =>
      remoteSmokeConfig({
        FABRIQO_MCP_SMOKE_BASE_URL: 'https://mcp-staging.fabriqo.app/mcp',
      }),
    ).toThrow('FABRIQO_MCP_SMOKE_OAUTH_ACCESS_TOKEN');
    expect(() =>
      remoteSmokeConfig({
        FABRIQO_MCP_SMOKE_BASE_URL: 'https://mcp-staging.fabriqo.app/mcp',
        FABRIQO_MCP_SMOKE_OAUTH_ACCESS_TOKEN: 'fab_test_workspace',
      }),
    ).toThrow('MCP OAuth');
  });

  it.each([
    'https://mcp.fabriqo.app/mcp',
    'https://mcp.fabriqo.app./mcp',
    'https://mcp.fabriqo.app:443/mcp',
  ])('blocks production target %s unless explicitly enabled', (url) => {
    const environment = {
      FABRIQO_MCP_SMOKE_BASE_URL: url,
      FABRIQO_MCP_SMOKE_OAUTH_ACCESS_TOKEN: 'fixture-oauth-token',
    };
    expect(() => remoteSmokeConfig(environment)).toThrow('--allow-production');
    expect(remoteSmokeConfig(environment, true).baseUrl).toBeInstanceOf(URL);
  });

  it.each([
    'http://mcp-staging.fabriqo.app/mcp',
    'https://user:password@mcp-staging.fabriqo.app/mcp',
    'https://mcp-staging.fabriqo.app',
    'https://mcp-staging.fabriqo.app/mcp?token=x',
    'https://mcp-staging.fabriqo.app/mcp#x',
  ])('rejects unsafe or non-MCP smoke target %s', (url) => {
    expect(() =>
      remoteSmokeConfig({
        FABRIQO_MCP_SMOKE_BASE_URL: url,
        FABRIQO_MCP_SMOKE_OAUTH_ACCESS_TOKEN: 'fixture-oauth-token',
      }),
    ).toThrow();
  });
});
