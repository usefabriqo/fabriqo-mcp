import { randomUUID } from 'node:crypto';
import type {
  CallToolResult,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server';
import { containsOAuthAccessToken } from '../auth/contract.js';
import {
  normalizeError,
  presentToolError,
  redactText,
  SafeError,
  safeRequestId,
} from '../errors/index.js';
import { MutationToolResult, ToolResult } from '../schemas/index.js';
import type {
  FabriqoClientFactory,
  InvocationContext,
  ResponseMetadata,
} from '../sdk/client-factory.js';
import { type ToolName, toolContract, toolNames } from './contract.js';
import { operations, type ToolInput } from './operations.js';
import { toolSchemas } from './schemas.js';

export interface ToolEvent {
  toolName: ToolName;
  outcome: 'success' | 'error';
  durationMs: number;
  requestId?: string;
}

export interface ToolDependencies {
  clientFactory: FabriqoClientFactory;
  /** Remote closures check this exact scope before exchanging the MCP bearer. */
  resolveCredential: (
    requiredScope?: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  idempotencyKeyFactory?: (toolName: ToolName) => string;
  /** Additional configured secrets to redact, such as OAuth/Access client secrets. */
  secrets?: readonly string[];
  onToolEvent?: (event: ToolEvent) => void;
}

class SafeToolError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reject known credentials and contract-valid token shapes, preserving ordinary data. */
function containsCredential(
  value: unknown,
  secrets: readonly string[],
): boolean {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      if (
        containsOAuthAccessToken(item) ||
        secrets.some(
          (secret) =>
            secret &&
            (item === secret || (secret.length >= 8 && item.includes(secret))),
        )
      )
        return true;
    } else if (item !== null && typeof item === 'object') {
      if (visited.has(item)) continue;
      visited.add(item);
      for (const [key, nested] of Object.entries(item)) {
        pending.push(key, nested);
      }
    }
  }
  return false;
}

export function newIdempotencyKey(): string {
  return `mcp:v1:${randomUUID()}`;
}

function effectiveKey(
  name: ToolName,
  args: Record<string, unknown>,
  token: string,
  dependencies: ToolDependencies,
): string {
  const explicit = args.idempotency_key;
  const key = (
    typeof explicit === 'string'
      ? explicit
      : (dependencies.idempotencyKeyFactory?.(name) ?? newIdempotencyKey())
  ).trim();
  const secrets = [token, ...(dependencies.secrets ?? [])];
  if (containsCredential(key, secrets)) {
    throw new SafeToolError(
      'The idempotency key must not contain a Fabriqo credential.',
    );
  }
  if (!/^[\x21-\x7e]{1,200}$/.test(key))
    throw new SafeError({
      category: 'validation',
      code: 'invalid_idempotency_key',
      message:
        'The idempotency key must be a non-empty value of at most 200 characters.',
    });
  return key;
}

/** One bounded tool invocation; the SDK exclusively owns API transport/retries. */
export async function executeTool<N extends ToolName>(
  name: N,
  input: unknown,
  dependencies: ToolDependencies,
  context: InvocationContext = {},
): Promise<CallToolResult> {
  const started = performance.now();
  const contract = toolContract[name];
  let token = '';
  let idempotencyKey: string | undefined;
  let outcome: ToolEvent['outcome'] = 'error';
  let responseRequestId: string | undefined;
  let responseMetadata: ResponseMetadata | undefined;
  let attempted = false;
  try {
    const parsed = toolSchemas[name].safeParse(input);
    if (!parsed.success) {
      // Do not print rejected values: arguments may contain credential material.
      const problems = parsed.error.issues
        .slice(0, 5)
        .map(
          (issue) =>
            `${issue.path.join('.') || 'input'}: ${issue.code === 'unrecognized_keys' ? 'Unrecognized argument.' : issue.message}`,
        );
      throw new SafeToolError(`Invalid tool arguments. ${problems.join('; ')}`);
    }
    const args = parsed.data as ToolInput<N>;
    token = (
      await dependencies.resolveCredential(
        contract.requiredScope ?? undefined,
        context.signal,
      )
    ).trim();
    if (!token)
      throw new SafeToolError(
        'A Fabriqo Workspace API bearer credential is required.',
      );
    const secrets = [token, ...(dependencies.secrets ?? [])];
    if (contract.kind === 'keyed')
      idempotencyKey = effectiveKey(name, args, token, dependencies);
    const handle = dependencies.clientFactory(token, {
      ...context,
      requestId: safeRequestId(context.requestId, secrets),
    });
    responseMetadata = handle.metadata;
    attempted = true;
    let data = await operations[name](handle.client, args, {
      ...context,
      signal: handle.signal ?? context.signal,
      idempotencyKey,
    });
    responseRequestId = safeRequestId(handle.metadata.requestId, secrets);
    if (
      name === 'remove_bom_component' &&
      ((data == null && handle.metadata.status === 204) ||
        (isObject(data) && Object.keys(data).length === 0))
    ) {
      data = {
        bom_component_id: (args as ToolInput<'remove_bom_component'>)
          .bom_component_id,
        removed: true,
      };
    }
    if (!isObject(data) || containsCredential(data, secrets))
      throw new SafeError({
        category: 'protocol',
        code: 'workspace_api_invalid_response',
        message: 'Fabriqo returned an invalid response.',
      });
    const result =
      contract.kind === 'keyed'
        ? MutationToolResult.parse({
            data,
            request_id: responseRequestId ?? null,
            idempotency_key: idempotencyKey,
            replayed:
              typeof data.replayed === 'boolean'
                ? data.replayed
                : handle.metadata.status === 200,
          })
        : ToolResult.parse({ data, request_id: responseRequestId ?? null });
    outcome = 'success';
    return {
      structuredContent: result,
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (error) {
    const secrets = [token, ...(dependencies.secrets ?? [])];
    const normalized =
      attempted && error instanceof SyntaxError
        ? new SafeError({
            category: 'protocol',
            code: 'workspace_api_invalid_response',
            message: 'Fabriqo returned an invalid response.',
          })
        : normalizeError(error, secrets);
    responseRequestId = safeRequestId(
      normalized.requestId ?? responseMetadata?.requestId,
      secrets,
    );
    const presented = new SafeError({
      ...normalized,
      message: normalized.message,
      requestId: responseRequestId,
    });
    let message =
      error instanceof SafeToolError
        ? redactText(error.message, secrets)
        : presentToolError(presented, {
            secrets,
            requiredScope: contract.requiredScope ?? undefined,
          });
    if (attempted && idempotencyKey) {
      if (
        normalized.retryable ||
        ['protocol', 'response_too_large', 'unavailable'].includes(
          normalized.category,
        )
      ) {
        message += ` For a deliberate retry of this exact write, reuse idempotency key ${idempotencyKey}; do not change the payload.`;
      }
    }
    return { isError: true, content: [{ type: 'text', text: message }] };
  } finally {
    // Observability must never turn a completed mutation into an apparent failure.
    try {
      dependencies.onToolEvent?.({
        toolName: name,
        outcome,
        durationMs: performance.now() - started,
        requestId: safeRequestId(responseRequestId, [
          token,
          ...(dependencies.secrets ?? []),
        ]),
      });
    } catch {}
  }
}

export function registerTools(
  server: McpServer,
  dependencies: ToolDependencies,
): void {
  for (const name of toolNames) {
    const contract = toolContract[name];
    server.registerTool(
      name,
      {
        description: contract.description,
        annotations: contract.annotations,
        inputSchema: toolSchemas[name],
        outputSchema:
          contract.kind === 'keyed' ? MutationToolResult : ToolResult,
      },
      async (args: unknown, ctx: ServerContext) =>
        executeTool(name, args, dependencies, {
          requestId: String(ctx.mcpReq.id),
          signal: ctx.mcpReq.signal,
        }),
    );
  }
  // Own anticipated error presentation: the SDK's default validation messages
  // include supplied values and unknown tool names. Native dispatch and wire
  // projection remain in the SDK; executeTool validates inputs and outputs.
  server.server.setRequestHandler('tools/call', async (request, ctx) => {
    if (!Object.hasOwn(toolContract, request.params.name)) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Unknown Fabriqo tool.' }],
      };
    }
    const name = request.params.name as ToolName;
    const result = await executeTool(
      name,
      request.params.arguments ?? {},
      dependencies,
      { requestId: String(ctx.mcpReq.id), signal: ctx.mcpReq.signal },
    );
    return server.server.projectCallToolResult(result, undefined);
  });
}

export type { ToolName };
export { toolContract, toolNames, toolSchemas };
