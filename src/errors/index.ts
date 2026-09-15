import {
  FabriqoDecodingError,
  FabriqoError,
  FabriqoResponseTooLargeError,
  FabriqoTimeoutError,
} from '@usefabriqo/sdk';
import { CredentialError } from '../auth/credentials.js';

export type ErrorCategory =
  | 'credential'
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'unavailable'
  | 'protocol'
  | 'response_too_large'
  | 'client_closed';

const labels: Record<ErrorCategory, string> = {
  credential: 'Fabriqo credential unavailable',
  authentication: 'Fabriqo credential rejected',
  authorization: 'Fabriqo operation forbidden',
  not_found: 'Fabriqo resource not found',
  conflict: 'Fabriqo state conflict',
  validation: 'Fabriqo input rejected',
  rate_limited: 'Fabriqo rate limit reached',
  unavailable: 'Fabriqo temporarily unavailable',
  protocol: 'Fabriqo response could not be processed',
  response_too_large: 'Fabriqo response exceeded the safe limit',
  client_closed: 'Fabriqo API client unavailable',
};

export interface SafeErrorOptions {
  category: ErrorCategory;
  code: string;
  message: string;
  status?: number;
  retryable?: boolean;
  retryAfterSeconds?: number;
  requestId?: string;
  details?: unknown;
}

/** Internal errors must contain only public text; raw SDK errors are normalized first. */
export class SafeError extends Error implements SafeErrorOptions {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly requestId?: string;
  readonly details?: unknown;
  constructor(options: SafeErrorOptions) {
    super(options.message);
    this.name = 'SafeError';
    this.category = options.category;
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

const sensitiveKey =
  /authorization|cookie|credential|idempotency_?key|password|secret|token/i;
const oauthToken = /fqo_at_[a-f0-9]{24}_[A-Za-z0-9_-]{43}/g;
export function redactText(
  value: string,
  secrets: readonly string[] = [],
  limit = 500,
): string {
  let text = value;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(oauthToken, '[redacted]')
    .replace(/fab_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /\b(authorization|cookies?|credentials?|idempotency[_-]?key|password|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export function safeDetails(
  value: unknown,
  secrets: readonly string[] = [],
  depth = 0,
): unknown {
  if (value === null || depth >= 6) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactText(value, secrets, 2_000);
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((item) => safeDetails(item, secrets, depth + 1));
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [
          redactText(key, secrets, 100),
          sensitiveKey.test(key.replaceAll('-', '_'))
            ? '[redacted]'
            : safeDetails(item, secrets, depth + 1),
        ]),
    );
  return null;
}

export function safeRequestId(
  value: unknown,
  secrets: readonly string[] = [],
): string | undefined {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value) &&
    redactText(value, secrets) === value
    ? value
    : undefined;
}

function defaults(status?: number): SafeErrorOptions {
  if (status !== undefined && status >= 500)
    return {
      category: 'unavailable',
      code: 'workspace_api_unavailable',
      message: 'Fabriqo is temporarily unavailable.',
      status,
      retryable: true,
    };
  const known: Record<number, [ErrorCategory, string, string]> = {
    400: [
      'validation',
      'bad_request',
      'Fabriqo could not process the request.',
    ],
    401: [
      'authentication',
      'workspace_api_token_invalid',
      'The Fabriqo Workspace API credential is invalid, revoked, or expired.',
    ],
    403: [
      'authorization',
      'permission_denied',
      'The credential lacks a required scope or workspace entitlement.',
    ],
    404: [
      'not_found',
      'not_found',
      'The requested Fabriqo resource was not found.',
    ],
    408: [
      'unavailable',
      'workspace_api_request_timeout',
      'The Fabriqo Workspace API did not complete the request in time.',
    ],
    409: [
      'conflict',
      'conflict',
      'The request conflicts with current Fabriqo state or idempotency history.',
    ],
    413: [
      'validation',
      'request_body_too_large',
      'The request is too large for the Fabriqo Workspace API.',
    ],
    422: [
      'validation',
      'validation_error',
      'The request contains invalid values.',
    ],
    429: [
      'rate_limited',
      'workspace_api_rate_limited',
      'The Fabriqo Workspace API rate limit was reached.',
    ],
  };
  const [category, code, message] = known[status ?? 0] ?? [
    'protocol',
    'workspace_api_request_failed',
    'The Fabriqo Workspace API request failed.',
  ];
  return {
    category,
    code,
    message,
    status,
    retryable: status === 408 || status === 429,
  };
}

export function parseRetryAfter(
  value: unknown,
  now = Date.now(),
): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, Math.ceil((date - now) / 1000))
    : undefined;
}

export function normalizeError(
  error: unknown,
  secrets: readonly string[] = [],
): SafeError {
  if (error instanceof CredentialError)
    return new SafeError({
      category:
        error.code === 'oauth_scope_required' ? 'authorization' : 'credential',
      code: error.code,
      message: redactText(error.message, secrets),
    });
  if (error instanceof SafeError)
    return new SafeError({
      ...error,
      message: redactText(error.message, secrets),
      requestId: safeRequestId(error.requestId, secrets),
      details: safeDetails(error.details, secrets),
    });
  if (error instanceof FabriqoDecodingError)
    return new SafeError({
      category: 'protocol',
      code: 'workspace_api_invalid_response',
      message: 'Fabriqo returned an invalid response.',
      status: error.status,
      requestId: safeRequestId(error.requestId, secrets),
    });
  if (error instanceof FabriqoResponseTooLargeError)
    return new SafeError({
      category: 'response_too_large',
      code: 'workspace_api_response_too_large',
      message: 'Fabriqo returned a response that exceeded the safe limit.',
      status: error.status,
      requestId: safeRequestId(error.requestId, secrets),
    });
  if (error instanceof FabriqoTimeoutError)
    return new SafeError({
      category: 'unavailable',
      code: 'workspace_api_request_timeout',
      message:
        'The Fabriqo Workspace API did not complete the request in time.',
      retryable: true,
    });
  if (error instanceof FabriqoError) {
    // Inspect the SDK's already-decoded payload, never read/reparse HTTP here.
    const payload = error.payload;
    const envelope =
      payload && typeof payload === 'object' && 'error' in payload
        ? payload.error
        : undefined;
    const hasApiEnvelope =
      envelope &&
      typeof envelope === 'object' &&
      'code' in envelope &&
      typeof envelope.code === 'string' &&
      'message' in envelope &&
      typeof envelope.message === 'string';
    if ((error.status === 401 || error.status === 403) && !hasApiEnvelope) {
      return new SafeError({
        category: 'unavailable',
        code: 'workspace_api_authentication_unavailable',
        message: 'Fabriqo authentication is temporarily unavailable.',
        status: error.status,
        retryable: true,
        requestId: safeRequestId(error.requestId, secrets),
      });
    }
    const base = defaults(error.status);
    const details = safeDetails(error.details, secrets);
    const retryable =
      details &&
      typeof details === 'object' &&
      'retryable' in details &&
      typeof details.retryable === 'boolean'
        ? details.retryable
        : base.retryable;
    const code =
      error.code &&
      /^[a-z0-9][a-z0-9_.:-]{0,99}$/.test(error.code) &&
      redactText(error.code, secrets) === error.code
        ? error.code
        : base.code;
    return new SafeError({
      ...base,
      code,
      retryable,
      message:
        error.status < 500
          ? redactText(error.message, secrets) || base.message
          : base.message,
      requestId: safeRequestId(error.requestId, secrets),
      retryAfterSeconds: parseRetryAfter(error.retryAfter),
      details: error.status < 500 ? details : undefined,
    });
  }
  if (
    (error instanceof Error &&
      ['AbortError', 'TimeoutError', 'NetworkError'].includes(error.name)) ||
    error instanceof TypeError
  ) {
    return new SafeError({
      category: 'unavailable',
      code: 'workspace_api_unavailable',
      message: 'The Fabriqo Workspace API request could not complete.',
      retryable: true,
    });
  }
  return new SafeError(defaults());
}

export interface PresentationOptions {
  secrets?: readonly string[];
  requiredScope?: string;
  idempotencyKey?: string;
}
export function presentToolError(
  error: unknown,
  options: PresentationOptions = {},
): string {
  const safe = normalizeError(error, options.secrets);
  const parts = [`${labels[safe.category]} [${safe.code}]: ${safe.message}`];
  if (options.requiredScope)
    parts.push(`Required Workspace API scope: ${options.requiredScope}.`);
  if (safe.retryAfterSeconds !== undefined)
    parts.push(`Retry after ${safe.retryAfterSeconds} seconds.`);
  else if (safe.retryable)
    parts.push('This failure is retryable with backoff.');
  if (safe.requestId) parts.push(`Request ID: ${safe.requestId}.`);
  if (
    options.idempotencyKey &&
    (safe.retryable ||
      ['protocol', 'response_too_large', 'unavailable'].includes(safe.category))
  ) {
    parts.push(
      'For a deliberate retry of this exact write, reuse the same idempotency key and the exact same payload.',
    );
  }
  return parts.join(' ');
}
