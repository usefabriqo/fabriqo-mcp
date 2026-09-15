import { randomUUID } from 'node:crypto';
import { Fabriqo, type FabriqoOptions } from '@usefabriqo/sdk';
import { SafeError, safeRequestId } from '../errors/index.js';

export interface InvocationContext {
  requestId?: string;
  signal?: AbortSignal;
}

export interface ResponseMetadata {
  status?: number;
  requestId?: string;
}

export interface FabriqoClientHandle {
  client: Fabriqo;
  metadata: ResponseMetadata;
  /** Includes the invocation deadline; pass to SDK methods and their retry waits. */
  signal?: AbortSignal;
}

/** A fresh handle owns one credential and one invocation's response metadata. */
export type FabriqoClientFactory = (
  token: string,
  context?: InvocationContext,
) => FabriqoClientHandle;

export interface ClientFactoryOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  /** Defaults to the SDK's bounded read-only retry policy. */
  maxRetries?: number;
  /** Maximum decoded response bytes, including error responses. Default: 1 MiB. */
  maxResponseBytes?: number;
  /** One deadline for SDK attempts, backoff, and response consumption. Default: 20s. */
  timeoutMs?: number;
}

function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
  error: () => SafeError,
): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(error());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(error());
    signal.addEventListener('abort', abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

async function boundedResponse(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  metadata: ResponseMetadata,
  aborted: () => SafeError,
): Promise<Response> {
  const invalidResponse = () =>
    new SafeError({
      category: 'protocol',
      code: 'workspace_api_invalid_response',
      message: 'Fabriqo returned an invalid response.',
      status: response.status,
      requestId: metadata.requestId,
    });
  const requiresBody =
    response.status >= 200 && response.status < 300 && response.status !== 204;
  const tooLarge = () =>
    new SafeError({
      category: 'response_too_large',
      code: 'workspace_api_response_too_large',
      message: 'Fabriqo returned a response that exceeded the safe limit.',
      status: response.status,
      requestId: metadata.requestId,
    });
  const declaredLength = response.headers.get('Content-Length');
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maximum
  ) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) {
    if (requiresBody) throw invalidResponse();
    return response;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal, aborted);
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    // Do not let an uncooperative upstream cancellation delay the public error.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  // The generated SDK treats Content-Length: 0 as an empty object. Preserve
  // Python's rule that a successful body may be empty only for HTTP 204.
  if ((size === 0 && requiresBody) || (size > 0 && declaredLength === '0'))
    throw invalidResponse();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(response.headers);
  // Every selected Workspace API operation returns JSON (or empty 204).
  // Preserve Python's MIME-independent JSON decoding through the SDK's decoder.
  if (requiresBody) headers.set('Content-Type', 'application/json');
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The SDK creates every Workspace API request. Its supported fetch extension is
 * used for operational headers, response metadata, and bounded byte/deadline
 * safeguards that its data-only API currently omits. No routing, JSON parsing,
 * business response typing, or retry behavior is implemented here.
 */
export function createClientFactory(
  options: ClientFactoryOptions,
): FabriqoClientFactory {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const maximum = options.maxResponseBytes ?? 1_048_576;
  const configuredTimeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new RangeError('maxResponseBytes must be a positive safe integer.');
  if (
    !Number.isFinite(configuredTimeoutMs) ||
    configuredTimeoutMs <= 0 ||
    configuredTimeoutMs > 2_147_483_647
  )
    throw new RangeError(
      'timeoutMs must be positive and no greater than 2147483647.',
    );
  const timeoutMs = Math.ceil(configuredTimeoutMs);
  return (token, context = {}) => {
    const credential = typeof token === 'string' ? token.trim() : '';
    if (!/^[\x21-\x7e]+$/.test(credential))
      throw new SafeError({
        category: 'credential',
        code: 'workspace_api_credential_required',
        message: 'A Fabriqo Workspace API bearer credential is required.',
      });
    const secrets = [
      credential,
      options.cfAccessClientId ?? '',
      options.cfAccessClientSecret ?? '',
    ];
    const requestId = safeRequestId(context.requestId, secrets) ?? randomUUID();
    const metadata: ResponseMetadata = { requestId };
    const deadline = AbortSignal.timeout(timeoutMs);
    const abortSource = context.signal
      ? AbortSignal.any([context.signal, deadline])
      : deadline;
    const aborted = () =>
      new SafeError({
        category: 'unavailable',
        code: deadline.aborted
          ? 'workspace_api_request_timeout'
          : 'workspace_api_request_cancelled',
        message: deadline.aborted
          ? 'The Fabriqo Workspace API did not complete the request in time.'
          : 'The Fabriqo Workspace API request was cancelled.',
        retryable: deadline.aborted,
        status: metadata.status,
        requestId: metadata.requestId,
      });
    // The SDK calls signal.throwIfAborted() around attempts. Give it a safe
    // classified reason instead of letting a caller-controlled reason replace
    // the deadline/cancellation error raised by the fetch decorator.
    const budget = new AbortController();
    if (abortSource.aborted) budget.abort(aborted());
    else
      abortSource.addEventListener('abort', () => budget.abort(aborted()), {
        once: true,
      });
    const signal = budget.signal;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const original = new Request(input, init);
      const requestSignal = AbortSignal.any([original.signal, signal]);
      if (requestSignal.aborted) throw aborted();
      const request = new Request(original, {
        signal: requestSignal,
        credentials: 'omit',
      });
      request.headers.set('X-Request-ID', requestId);
      // Only server configuration can supply Access credentials.
      request.headers.delete('CF-Access-Client-Id');
      request.headers.delete('CF-Access-Client-Secret');
      if (options.cfAccessClientId && options.cfAccessClientSecret) {
        request.headers.set('CF-Access-Client-Id', options.cfAccessClientId);
        request.headers.set(
          'CF-Access-Client-Secret',
          options.cfAccessClientSecret,
        );
      }
      const pending = baseFetch(request);
      // A custom fetch may ignore abort; release its eventual response in that case.
      void pending
        .then((response) => {
          if (requestSignal.aborted)
            void response.body?.cancel().catch(() => {});
        })
        .catch(() => {});
      const response = await abortable(pending, requestSignal, aborted);
      metadata.status = response.status;
      metadata.requestId =
        safeRequestId(response.headers.get('X-Request-ID'), secrets) ??
        requestId;
      return boundedResponse(
        response,
        maximum,
        requestSignal,
        metadata,
        aborted,
      );
    };
    const sdkOptions: FabriqoOptions = {
      apiKey: credential,
      baseUrl: options.baseUrl,
      fetch,
      timeoutMs,
      maxResponseBytes: maximum,
    };
    if (options.maxRetries !== undefined)
      sdkOptions.maxRetries = options.maxRetries;
    return { client: new Fabriqo(sdkOptions), metadata, signal };
  };
}
