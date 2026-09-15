import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectPath,
  inspectText,
  scanRepository,
} from '../scripts/check-release.mjs';

const token = ['ghp', 'Ab9Z'.repeat(10)].join('_');

describe('public release content guard', () => {
  it('detects tokens anywhere, including tests, without echoing them', () => {
    const findings = inspectText('tests/fixture.json', `first\n${token}`);
    expect(findings).toEqual([
      { path: 'tests/fixture.json', line: 2, rule: 'credential' },
    ]);
    expect(JSON.stringify(findings)).not.toContain(token);
  });

  it('detects private keys, authenticated URLs, and developer paths', () => {
    for (const value of [
      ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
      ['https://', 'alice:example-password', '@example.test'].join(''),
      ['/', 'Users', 'developer', 'secret.txt'].join('/').slice(1),
    ])
      expect(inspectText('example.txt', value)).not.toEqual([]);
  });

  it('detects unfamiliar high-entropy credential assignments', () => {
    const value = ['Ar8bC2dE', '9fG4hI6jK', '1Lm7No3Pq5Rs'].join('');
    expect(
      inspectText('config.ts', `const apiToken = '${value}'`)[0].rule,
    ).toBe('credential-assignment');
  });

  it('allows placeholders and public URLs', () => {
    expect(
      inspectText('README.md', 'API_TOKEN="..." https://api.fabriqo.app'),
    ).toEqual([]);
    expect(inspectPath('.env.example')).toEqual([]);
  });

  it.each([
    '.env',
    'nested/.env.production',
    '.npmrc',
    'server.key',
    'data.sqlite',
    'trace.log',
    'node_modules/a.js',
  ])('rejects private file %s', (path) => {
    expect(inspectPath(path)).not.toEqual([]);
  });

  it('finds secrets retained only in history, staged content, and untracked files', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mcp-release-test-'));
    const git = (...args) =>
      execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    try {
      git('init', '--quiet');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.test');
      writeFileSync(resolve(root, 'old.txt'), token);
      writeFileSync(resolve(root, 'tab\tname.txt'), token);
      writeFileSync(resolve(root, 'safe.txt'), 'ordinary fixture');
      writeFileSync(resolve(root, '.env'), 'ordinary fixture');
      mkdirSync(resolve(root, 'tests'));
      const mock = ['fab', 'test', 'service-token'].join('_');
      expect(inspectText('tests/auth.test.ts', mock)).toEqual([]);
      writeFileSync(resolve(root, 'tests/auth.test.ts'), mock);
      writeFileSync(resolve(root, 'copied-mock.txt'), mock);
      git('add', '.');
      git(
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '-m',
        'Synthetic fixture',
      );
      git(
        'rm',
        '--quiet',
        'old.txt',
        'tab\tname.txt',
        '.env',
        'copied-mock.txt',
      );
      git(
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '-m',
        'Remove fixture',
      );
      writeFileSync(resolve(root, 'staged.txt'), token);
      git('add', 'staged.txt');
      writeFileSync(resolve(root, 'staged.txt'), 'safe working copy');
      writeFileSync(resolve(root, 'untracked.txt'), token);
      symlinkSync('missing-target', resolve(root, 'broken-link'));
      const result = scanRepository(root);
      expect(
        result.findings.some((f) => f.path === 'old.txt' && f.revision),
      ).toBe(true);
      expect(
        result.findings.some((f) => f.path === 'staged.txt' && f.revision),
      ).toBe(true);
      expect(
        result.findings.some((f) => f.path === 'untracked.txt' && !f.revision),
      ).toBe(true);
      expect(result.findings.some((f) => f.path === '.env' && f.revision)).toBe(
        true,
      );
      expect(
        result.findings.some((f) => f.path === 'copied-mock.txt' && f.revision),
      ).toBe(true);
      expect(result.findings.some((f) => f.path === 'tests/auth.test.ts')).toBe(
        false,
      );
      expect(
        result.findings.some((f) => f.path === 'tab\tname.txt' && f.revision),
      ).toBe(true);
      expect(
        result.findings.some(
          (f) => f.path === 'broken-link' && f.rule === 'non-regular-file',
        ),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain(token);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
