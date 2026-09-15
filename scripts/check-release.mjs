import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact, reviewed synthetic fixtures only. Never exempt a whole test directory.
const synthetic = new Map([
  [
    'scripts/smoke.ts',
    ['d68933f59adce3eb561ad67336c78642e71af3ebb61dd3855cd54651ad3fd721'],
  ],
  [
    'tests/auth.test.ts',
    [
      'ca2ad93bf04e7f29677154b2e80fa659fbea8b50e16d277de069b047c1e60b72',
      '4b1eeda1728bf4cdc7e9a98c550ee0912979644f1ed40473ba2b98790b081b3b',
    ],
  ],
  [
    'tests/http.test.ts',
    ['0c1b5b80cda75435720673a5b28a8c98e5587e4ba8c2dc6e717372941d22ba12'],
  ],
  [
    'tests/stdio.test.ts',
    [
      'a1f15babac38c985e21f0afe7d989769605911a1e75618a8c21d73109b13e589',
      '093866188144b0216fb125431572e8ac2df8980dfeeb6ebeb3d9f3987d1e4c1d',
    ],
  ],
  [
    'tests/config.test.ts',
    ['fbddae166ead16d1dd67736b19403ab1ac0095e344f663573848af911a7ce273'],
  ],
]);

const patterns = [
  [
    'credential',
    /fqo_at_[a-f0-9]{24}_[A-Za-z0-9_-]{43}|fab_(?:test|live)_[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  ],
  ['private-key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g],
  ['credential-in-url', /[a-z][a-z0-9+.-]*:\/\/[^\s/"'<>]*:[^\s/"'<>]*@/g],
  ['developer-path', /\/(?:Users|home)\/[^/\s]+\//g],
];

function entropy(value) {
  return [...new Set(value)].reduce((sum, character) => {
    const p = value.split(character).length / value.length - 1 / value.length;
    return sum - p * Math.log2(p);
  }, 0);
}

/** Return locations/rules only; never include the matched secret in diagnostics. */
export function inspectText(path, text) {
  const findings = [];
  function report(rule, match, value = match[0]) {
    const digest = createHash('sha256').update(value).digest('hex');
    if (synthetic.get(path)?.includes(digest)) return;
    findings.push({
      path,
      line: text.slice(0, match.index).split('\n').length,
      rule,
    });
  }
  for (const [rule, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) report(rule, match);
  }
  const assignments =
    /[\w.-]*(?:secret|password|token|api[_-]?key|private[_-]?key)[\w.-]*["']?\s*[:=]\s*["']([A-Za-z0-9_+/=.-]{20,})["']/gi;
  for (const match of text.matchAll(assignments)) {
    if (entropy(match[1]) >= 3.7)
      report('credential-assignment', match, match[1]);
  }
  return findings;
}

export function inspectPath(path) {
  return /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.DS_Store|node_modules|coverage|\.venv|\.ruff_cache|__pycache__)(?:\/|$)|\.(?:pem|key|p12|pfx|tgz|sqlite3?|db|log)$/i.test(
    path,
  ) && !/(^|\/)\.env\.example$/.test(path)
    ? [{ path, line: 1, rule: 'private-or-generated-file' }]
    : [];
}

/** Scan publishable working files, the index, and every locally available ref. */
export function scanRepository(root = process.cwd()) {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
    throw new Error(
      'Release scanning requires full Git history (fetch-depth: 0).',
    );
  }
  const findings = [];
  const files = new Set(
    git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
      .split('\0')
      .filter(Boolean),
  );
  for (const path of files) {
    const absolute = resolve(root, path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) continue; // Uncommitted deletions are scanned in history/index.
    findings.push(...inspectPath(path));
    if (!stat.isFile()) {
      findings.push({ path, line: 1, rule: 'non-regular-file' });
      continue;
    }
    findings.push(...inspectText(path, readFileSync(absolute, 'utf8')));
  }
  // rev-list names only one path per object. A blob may have other historical
  // paths with different file rules or fixture exemptions, so enumerate trees.
  const objects = new Map();
  for (const oid of git('rev-list', '--objects', '--no-object-names', '--all')
    .trim()
    .split('\n')
    .filter(Boolean)) {
    objects.set(oid, git('cat-file', '-t', oid).trim());
  }
  const trees = new Set();
  const blobs = new Map();
  function addFile(mode, oid, path) {
    if (!['100644', '100755'].includes(mode)) {
      findings.push({
        path,
        line: 1,
        rule: 'non-regular-file',
        revision: oid.slice(0, 12),
      });
      return;
    }
    if (!blobs.has(oid)) blobs.set(oid, new Set());
    blobs.get(oid).add(path);
    objects.set(oid, 'blob');
  }
  for (const [oid, type] of objects) {
    if (!['commit', 'tag'].includes(type)) continue;
    const content = git('cat-file', '-p', oid);
    if (type === 'commit') trees.add(content.split('\n', 1)[0].slice(5));
    else {
      const target = content.split('\n', 1)[0].slice(7);
      if (objects.get(target) === 'tree') trees.add(target);
    }
    for (const finding of inspectText('', content)) {
      findings.push({ ...finding, revision: oid.slice(0, 12) });
    }
  }
  // Local tools can retain snapshots as refs pointing directly at a tree.
  for (const oid of git('for-each-ref', '--format=%(objectname)')
    .trim()
    .split('\n')
    .filter(Boolean)) {
    if (objects.get(oid) === 'tree') trees.add(oid);
  }
  for (const tree of trees) {
    for (const row of git('ls-tree', '-r', '-z', tree)
      .split('\0')
      .filter(Boolean)) {
      const tab = row.indexOf('\t');
      const [mode, , oid] = row.slice(0, tab).split(' ');
      addFile(mode, oid, row.slice(tab + 1));
    }
  }
  for (const row of git('ls-files', '--stage', '-z')
    .split('\0')
    .filter(Boolean)) {
    const tab = row.indexOf('\t');
    const [mode, oid] = row.slice(0, tab).split(' ');
    addFile(mode, oid, row.slice(tab + 1));
  }
  // A ref or tag can also retain a blob directly, without a containing tree.
  for (const [oid, type] of objects) {
    if (type === 'blob' && !blobs.has(oid)) blobs.set(oid, new Set(['']));
  }
  for (const [oid, paths] of blobs) {
    const content = git('cat-file', '-p', oid);
    for (const path of paths) {
      for (const finding of [
        ...inspectPath(path),
        ...inspectText(path, content),
      ]) {
        findings.push({ ...finding, revision: oid.slice(0, 12) });
      }
    }
  }
  return { files: files.size, objects: objects.size, findings };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = scanRepository();
  if (result.findings.length) {
    for (const finding of result.findings) {
      console.error(
        `${finding.revision ? `${finding.revision}:` : ''}${JSON.stringify(finding.path)}:${finding.line}: ${finding.rule} [REDACTED]`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Release scan passed: ${result.files} working paths, index, and ${result.objects} Git objects; no unapproved secret-pattern or file-hygiene findings.`,
    );
  }
}
