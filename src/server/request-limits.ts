import type { IncomingMessage } from 'node:http';

export class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
export const REQUEST_BODY_DEADLINE_MS = 5_000;

/** One hard deadline for all chunks: a slow drip never resets it. */
async function boundedChunks(
  iterator: AsyncIterator<Uint8Array>,
  maximum: number,
  deadlineMs: number,
  declaredSize?: string | null,
): Promise<Uint8Array> {
  if (
    declaredSize &&
    /^\d+$/.test(declaredSize) &&
    Number(declaredSize) > maximum
  )
    throw new RequestBodyError(
      413,
      'request_body_too_large',
      'The MCP request body is too large.',
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RequestBodyError(
            408,
            'request_body_timeout',
            'The MCP request body was not received in time.',
          ),
        ),
      deadlineMs,
    );
  });
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum)
        throw new RequestBodyError(
          413,
          'request_body_too_large',
          'The MCP request body is too large.',
        );
      chunks.push(next.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export async function readNodeBody(
  request: IncomingMessage,
  maximum: number,
  deadlineMs = REQUEST_BODY_DEADLINE_MS,
): Promise<Uint8Array> {
  return boundedChunks(
    request[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>,
    maximum,
    deadlineMs,
    request.headers['content-length'],
  );
}

export async function readWebBody(
  request: Request,
  maximum: number,
  deadlineMs = REQUEST_BODY_DEADLINE_MS,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  try {
    return await boundedChunks(
      {
        next: async () => {
          const item = await reader.read();
          return item.done
            ? { done: true, value: undefined }
            : { done: false, value: item.value };
        },
      },
      maximum,
      deadlineMs,
      request.headers.get('content-length'),
    );
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
