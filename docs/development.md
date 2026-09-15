# Development

This guide covers development of `usefabriqo/fabriqo-mcp`.

For instructions on using Fabriqo MCP, see [docs.fabriqo.app](https://docs.fabriqo.app).

## Requirements

Node.js 22.18 or newer.

Install dependencies:

```sh
npm ci
```

Run the complete local verification suite:

```sh
npm run check
```

## Checks

The repository includes strict TypeScript checking, linting, tests, builds, architecture validation, and package-consumer verification.

Common commands:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run architecture:check
npm run release:check
npm run check
```

Use the scripts defined in `package.json` as the authoritative command list.

## SDK dependency

All Fabriqo business operations use the published:

```text
@usefabriqo/sdk
```

The MCP must not depend on a sibling SDK checkout, local tarball, or `file:` dependency.

Do not import SDK source files directly.

If MCP development reveals an SDK limitation, document or fix it in `usefabriqo/fabriqo-node` rather than bypassing the SDK from this repository.

## Architecture checks

The architecture check verifies important repository boundaries, including:

```sh
node scripts/check-architecture.mjs
```

It ensures that business tools do not bypass `@usefabriqo/sdk` with handwritten API paths or direct HTTP calls.

## Public release hygiene

`npm run release:check` scans tracked and unignored working files, staged content, and all locally available Git refs for credential patterns, credential-bearing URLs, developer paths, and private files. CI fetches full history for this check. Exact reviewed synthetic test values are allowlisted by file and SHA-256; test directories are never exempted wholesale. Diagnostics identify locations without printing matched values.

The scan is heuristic and does not replace review for confidential business logic or unfamiliar secret formats. Deleting a sensitive file from the working tree does not remove it from Git history. Review ignored local files before sharing a directory, and publish through Git or the verified npm artifact rather than uploading the entire checkout.

Check current dependency advisories before release:

```sh
npm audit
```

## Package verification

Before release, build and inspect the actual package artifact:

```sh
npm run build
npm pack --dry-run
```

Builds clear generated `dist` output first. The package verifier checks the exact expected file list, scans the artifact, then installs it into an isolated consumer and verifies its public API and CLI behavior.

Run the repository's package verification command as part of `npm run check`.

The npm artifact should not contain development-only files, credentials, `.env` files, local package archives, or developer-specific filesystem paths.

## Smoke testing

The normal smoke test uses local fixtures and does not require Fabriqo credentials:

```sh
npm run smoke
```

Credentialed staging validation is a separate release step and must use explicitly supplied staging credentials.

Production writes must never be used to complete a release check.

## Local stdio development

Set a Fabriqo API token:

```sh
export FABRIQO_API_TOKEN="..."
export FABRIQO_API_BASE_URL="https://api.fabriqo.app"
```

Then run the built or development CLI using the scripts provided by the repository.

Local stdio authentication uses the API token directly and does not require OAuth.

## Remote development

Remote HTTP mode requires the MCP OAuth configuration described in [configuration.md](configuration.md).

Never commit OAuth client secrets, API tokens, or other deployment credentials.

## Tests

Tests should cover behavior rather than implementation details.

Important areas include:

- MCP tool contracts
- Zod input validation
- SDK operation mapping
- permission enforcement
- OAuth token isolation
- idempotency behavior
- structured results
- error redaction
- pagination
- HTTP transport security

Tests should not require a Python checkout or sibling repository.

## Pull requests

Before submitting a pull request:

```sh
npm ci
npm run check
npm pack --dry-run
```

Generated or derived fixtures should only be changed intentionally and reviewed with the behavior they represent.

Do not weaken architecture, authentication, or package-hygiene checks merely to make CI pass.

## Release preparation

Before publishing a release:

```sh
npm ci
npm run check
npm run smoke
npm pack --dry-run
```

Then complete the credentialed staging validation defined by the Fabriqo release process.

Publishing and production deployment are explicit maintainer actions and are not performed by normal development scripts.
