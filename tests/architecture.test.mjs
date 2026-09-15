import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSource } from '../scripts/check-architecture.mjs';

const root = resolve('src');
const check = (source, path = 'tools/example.ts') =>
  checkSource(resolve(root, path), source, root);

describe('public SDK architecture boundary', () => {
  it.each([
    "import { Fabriqo } from '@usefabriqo/sdk/dist/index.js';",
    "export * from '@usefabriqo/sdk/src/client.js';",
    "type PrivateClient = import('@usefabriqo/sdk/src/client.js').Client;",
    "import api from '../../../private-app/business.js';",
    "import api from '/opt/private-fabriqo/services.js';",
    "import api from 'file:///opt/private-fabriqo/services.js';",
    "import { request as send } from 'node:http'; send(url);",
    "import * as network from 'node:net';",
    "import { connect } from 'node:net';",
    "import axios from 'axios';",
    "export * from 'node:https';",
    "await import('@usefabriqo/sdk/src/private.js');",
    'await import(siblingModule);',
    "require('node:http');",
    'new Function(source)();',
  ])('rejects unreviewed imports and dynamic loading: %s', (source) => {
    expect(() => check(source)).toThrow();
  });

  it.each([
    'fetch(url);',
    'globalThis.fetch(url);',
    'const send = globalThis.fetch; send(url);',
    "const send = globalThis['fetch']; send(url);",
    'const { fetch: send } = globalThis; send(url);',
  ])('rejects outbound fetch in business tools and helpers: %s', (source) => {
    expect(() => check(source)).toThrow(/outbound fetch/);
    expect(() => check(source, 'schemas/helper.ts')).toThrow(/outbound fetch/);
  });

  it.each([
    "const route = '/v1/products';",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Source snippet is parsed, not executed.
    'const route = `/v1/products/${id}`;',
    "const route = '/v' + '1/products';",
    "const route = '\\x2fv1/products';",
    "const route = 'https://api.example.test/v1/products';",
    "const route = '/v2/products';",
  ])(
    'rejects handwritten routes, including transport exceptions: %s',
    (source) => {
      expect(() => check(source)).toThrow(/handwritten Workspace API path/);
      expect(() => check(source, 'sdk/client-factory.ts')).toThrow(
        /handwritten Workspace API path/,
      );
    },
  );

  it('permits typed public SDK calls and local adapter imports', () => {
    expect(() =>
      check(`
        import type { Fabriqo } from '@usefabriqo/sdk';
        import { queryParams } from '../schemas/index.js';
        export const preview = (client: Fabriqo, args) =>
          client.bomLines.costPreview(queryParams(args));
      `),
    ).not.toThrow();
  });

  it('permits reviewed infrastructure transport APIs', () => {
    for (const path of [
      'sdk/client-factory.ts',
      'auth/oauth.ts',
      'server/readiness.ts',
    ]) {
      expect(() =>
        check('const send = options.fetch ?? globalThis.fetch;', path),
      ).not.toThrow();
    }
    expect(() =>
      check(
        "import { createServer as listen, type IncomingMessage } from 'node:http'; mcp.fetch(request);",
        'server/http.ts',
      ),
    ).not.toThrow();
    expect(() =>
      check("import { isIP } from 'node:net';", 'auth/abuse.ts'),
    ).not.toThrow();
    expect(() =>
      check("import { request } from 'node:http';", 'server/http.ts'),
    ).toThrow(/unreviewed import/);
  });
});
