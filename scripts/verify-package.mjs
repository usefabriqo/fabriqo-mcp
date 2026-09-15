import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { inspectText } from './check-release.mjs';

function compiledFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      return compiledFiles(resolve(directory, entry.name), `${path}/`);
    assert(
      entry.isFile() && path.endsWith('.ts'),
      'Unexpected source artifact.',
    );
    return [`dist/${path.slice(0, -3)}.js`, `dist/${path.slice(0, -3)}.d.ts`];
  });
}

const expectedFiles = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'docs/configuration.md',
  'docs/architecture.md',
  'docs/development.md',
  ...compiledFiles('src'),
]);

const temp = mkdtempSync(resolve(tmpdir(), 'fabriqo-mcp-package-'));
try {
  const [artifact] = JSON.parse(
    execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', temp],
      { encoding: 'utf8' },
    ),
  );
  const names = artifact.files.map((file) => file.path);
  assert.deepEqual(
    new Set(names),
    expectedFiles,
    'Package file allowlist mismatch; remove stale build output or review new files.',
  );
  assert(names.includes('dist/cli.js'));
  assert(names.includes('dist/index.js'));
  assert(names.includes('dist/index.d.ts'));
  for (const name of names) {
    assert(
      name === 'package.json' ||
        name === 'README.md' ||
        name === 'LICENSE' ||
        name.startsWith('dist/') ||
        name.startsWith('docs/'),
      `Unwanted file: ${name}`,
    );
    assert(
      !/(^|\/)(\.env(?:\..*)?|node_modules|tests|coverage|src|\.git)(\/|$)|\.(?:tgz|pem|key|p12|pfx)$/.test(
        name,
      ),
      `Private or development artifact: ${name}`,
    );
  }
  execFileSync('tar', ['-xzf', resolve(temp, artifact.filename), '-C', temp]);
  for (const name of names) {
    const text = readFileSync(resolve(temp, 'package', name), 'utf8');
    assert.deepEqual(
      inspectText(name, text),
      [],
      `Release content violation in ${name}`,
    );
  }
  const manifest = JSON.parse(
    readFileSync(resolve(temp, 'package/package.json'), 'utf8'),
  );
  assert.equal(manifest.name, '@usefabriqo/mcp');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.bin['fabriqo-mcp'], 'dist/cli.js');
  assert.equal(
    manifest.repository.url,
    'git+https://github.com/usefabriqo/fabriqo-mcp.git',
  );
  assert.match(manifest.dependencies['@usefabriqo/sdk'], /^\^0\.\d+\.\d+$/);
  for (const value of Object.values(manifest.dependencies)) {
    assert(!/^(?:file:|link:|workspace:)|\.tgz$/.test(value));
  }
  const consumer = resolve(temp, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    resolve(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
      resolve(temp, artifact.filename),
    ],
    { cwd: consumer, stdio: 'pipe' },
  );
  const consumerLock = JSON.parse(
    readFileSync(resolve(consumer, 'package-lock.json'), 'utf8'),
  );
  const sdk = consumerLock.packages['node_modules/@usefabriqo/sdk'];
  assert.match(sdk.version, /^0\.\d+\.\d+$/);
  assert.match(sdk.resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.match(sdk.integrity, /^sha512-/);
  assert(!sdk.link);
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const m = await import('@usefabriqo/mcp'); if (typeof m.createServer !== 'function' || typeof m.startHttp !== 'function') process.exit(1)",
    ],
    { cwd: consumer },
  );
  const cli = resolve(consumer, 'node_modules/.bin/fabriqo-mcp');
  assert.equal(
    realpathSync(cli),
    realpathSync(resolve(consumer, 'node_modules/@usefabriqo/mcp/dist/cli.js')),
  );
  const client = new Client(
    { name: 'package-consumer-test', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StdioClientTransport({
    command: cli,
    env: {
      PATH: process.env.PATH ?? '',
      FABRIQO_ENV: 'test',
      FABRIQO_API_BASE_URL: 'https://api.example.test',
      FABRIQO_API_TOKEN: 'local-package-validation',
    },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 45);
  } finally {
    await client.close();
  }
  console.log(
    `Package checks passed: ${artifact.filename}; ${names.length} files; ${artifact.size} bytes; registry SDK ${sdk.version}; public import and installed CLI with 45 tools; artifact hygiene checks passed.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
