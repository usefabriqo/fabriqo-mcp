import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const fetchExtensions = new Set([
  'sdk/client-factory.ts',
  'auth/oauth.ts',
  'server/readiness.ts',
]);
const publicModules = new Set([
  '@usefabriqo/sdk',
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/server/stdio',
  '@modelcontextprotocol/node',
  'zod',
  'node:crypto',
  'node:util',
]);

function inside(root, target) {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}

function literalValue(node) {
  if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return literalValue(node.expression);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = literalValue(node.left);
    const right = literalValue(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

/** Regression guard for reviewed boundaries, not a proof against obfuscated code. */
export function checkSource(file, source, sourceRoot = resolve('src')) {
  const path = relative(sourceRoot, resolve(file));
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  function fail(message) {
    assert.fail(`${path}: ${message}`);
  }
  function checkImport(node, specifier = node.moduleSpecifier) {
    if (!specifier || !ts.isStringLiteralLike(specifier))
      fail('module imports must use a static public specifier');
    const name = specifier.text;
    if (name.startsWith('.')) {
      if (!inside(sourceRoot, resolve(dirname(file), name)))
        fail('source import escapes src (private or sibling source)');
      return;
    }
    if (publicModules.has(name)) return;
    // These modules can also open network connections: permit only the named
    // server adapter and IP parsing APIs that the MCP infrastructure needs.
    const allowed =
      name === 'node:net'
        ? ['isIP']
        : name === 'node:http' && path === 'server/http.ts'
          ? ['createServer', 'IncomingMessage', 'ServerResponse']
          : name === 'node:http' && path === 'server/request-limits.ts'
            ? ['IncomingMessage']
            : undefined;
    const bindings = ts.isImportDeclaration(node)
      ? node.importClause?.namedBindings
      : undefined;
    if (
      allowed &&
      !node.importClause?.name &&
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.every((item) =>
        allowed.includes((item.propertyName ?? item.name).text),
      )
    )
      return;
    fail(
      'unreviewed import; use public SDK exports and approved MCP infrastructure',
    );
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) checkImport(node);
    }
    if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument))
        fail('type imports must use a static public specifier');
      checkImport(node, node.argument.literal);
    }
    if (
      ts.isImportEqualsDeclaration(node) ||
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            ['require', 'eval', 'Function'].includes(node.expression.text)))) ||
      (ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Function')
    )
      fail('dynamic module loading or executable source is not permitted');
    const literal = literalValue(node);
    if (
      literal !== undefined &&
      /(?:^|https?:\/\/[^/]+)\/v\d+(?:\/|$)/.test(literal)
    )
      fail('handwritten Workspace API path; use the public SDK method');
    if (!fetchExtensions.has(path)) {
      if (
        (ts.isIdentifier(node) &&
          node.text === 'fetch' &&
          // Object declarations and MCP handler methods are not outbound fetch.
          !(
            (ts.isPropertyAssignment(node.parent) ||
              ts.isMethodDeclaration(node.parent)) &&
            node.parent.name === node
          ) &&
          !(
            ts.isPropertyAccessExpression(node.parent) &&
            node.parent.name === node
          )) ||
        ((ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
          ts.isIdentifier(node.expression) &&
          ['globalThis', 'global', 'window', 'self'].includes(
            node.expression.text,
          ) &&
          (ts.isPropertyAccessExpression(node)
            ? node.name.text
            : literalValue(node.argumentExpression)) === 'fetch')
      )
        fail(
          'outbound fetch is restricted to the SDK extension, OAuth, and readiness',
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    assert(
      !entry.isSymbolicLink(),
      `${directory}: source symlink is not permitted`,
    );
    return entry.isDirectory()
      ? walk(resolve(directory, entry.name))
      : [resolve(directory, entry.name)];
  });
}
export function checkArchitecture() {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const sdkName = '@usefabriqo/sdk';
  assert.equal(manifest.name, '@usefabriqo/mcp');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.bin['fabriqo-mcp'], 'dist/cli.js');
  assert.equal(manifest.dependencies['@modelcontextprotocol/server'], '2.0.0');
  assert.equal(manifest.dependencies['@modelcontextprotocol/node'], '2.0.0');
  assert.equal(manifest.dependencies['@modelcontextprotocol/sdk'], undefined);
  assert.match(manifest.dependencies[sdkName], /^\^0\.\d+\.\d+$/);
  assert.equal(
    manifest.repository.url,
    'git+https://github.com/usefabriqo/fabriqo-mcp.git',
  );
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  for (const [name, entry] of Object.entries(lock.packages)) {
    assert(!entry.link, `${name}: linked local dependency`);
    if (!name) continue;
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-/);
  }
  assert.match(
    lock.packages[`node_modules/${sdkName}`].version,
    /^0\.\d+\.\d+$/,
  );
  for (const file of walk('src').filter((file) => /\.[cm]?[jt]sx?$/.test(file)))
    checkSource(file, readFileSync(file, 'utf8'));
  console.log(
    'Architecture checks passed: public registry SDK, approved imports and transport extensions, no private source imports or handwritten business routes.',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  checkArchitecture();
