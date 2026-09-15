import { isIP } from 'node:net';
import type { TrustedClientIpMode } from '../config/settings.js';

export class InvalidTrustedClientIp extends Error {
  constructor() {
    super('The client network identity is unavailable.');
    this.name = 'InvalidTrustedClientIp';
  }
}

function ipv6Words(value: string): number[] {
  let canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  if (canonical.includes('.')) {
    const lastColon = canonical.lastIndexOf(':');
    const octets = canonical
      .slice(lastColon + 1)
      .split('.')
      .map(Number);
    canonical = `${canonical.slice(0, lastColon)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [leftPart, rightPart] = canonical.split('::');
  const left = leftPart
    ? leftPart.split(':').map((part) => Number.parseInt(part, 16))
    : [];
  const right = rightPart
    ? rightPart.split(':').map((part) => Number.parseInt(part, 16))
    : [];
  return rightPart === undefined
    ? left
    : [
        ...left,
        ...Array<number>(8 - left.length - right.length).fill(0),
        ...right,
      ];
}

function normalizedNetworkIdentity(value: string): string {
  const raw = value.trim();
  if (!raw || /[,%\u0080-\uffff]/.test(raw)) throw new InvalidTrustedClientIp();
  const family = isIP(raw);
  if (family === 4) return raw;
  if (family !== 6) throw new InvalidTrustedClientIp();
  const words = ipv6Words(raw);
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return `${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`;
  }
  const network = [...words.slice(0, 4), 0, 0, 0, 0]
    .map((word) => word.toString(16))
    .join(':');
  return `${new URL(`http://[${network}]/`).hostname.slice(1, -1)}/64`;
}

/** Headers combines duplicate field values with commas, which this rejects. */
export function clientNetworkIdentity(
  headers: Headers,
  mode: TrustedClientIpMode,
  socketAddress?: string,
): string {
  if (mode !== 'none') {
    const value = headers.get(
      mode === 'fly' ? 'fly-client-ip' : 'cf-connecting-ip',
    );
    if (value === null) throw new InvalidTrustedClientIp();
    return normalizedNetworkIdentity(value);
  }
  if (socketAddress) {
    try {
      return normalizedNetworkIdentity(socketAddress);
    } catch {
      /* Stable fallback for local test/Unix transports. */
    }
  }
  return 'direct-unknown';
}

interface FailureBucket {
  window: number;
  failures: number;
  inFlight: number;
}
export interface AuthAttemptReservation {
  readonly source: string;
}
export interface ReservationResult {
  reservation?: AuthAttemptReservation;
  retryAfter?: number;
}

/** Event-loop atomic fixed-window failure counters and concurrent reservations. */
export class McpAuthFailureLimiter {
  readonly #sourceLimit: number;
  readonly #windowSeconds: number;
  readonly #maxSources: number;
  readonly #clock: () => number;
  readonly #sources = new Map<string, FailureBucket>();
  readonly #reservations = new WeakSet<AuthAttemptReservation>();

  constructor(options: {
    sourceLimit: number;
    windowSeconds: number;
    maxSources: number;
    clock?: () => number;
  }) {
    for (const value of [
      options.sourceLimit,
      options.windowSeconds,
      options.maxSources,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(
          'Authentication limiter bounds must be positive integers.',
        );
    }
    this.#sourceLimit = options.sourceLimit;
    this.#windowSeconds = options.windowSeconds;
    this.#maxSources = options.maxSources;
    this.#clock = options.clock ?? (() => performance.now() / 1000);
  }

  tryReserve(source: string): ReservationResult {
    const now = this.#clock();
    const window = Math.floor(now / this.#windowSeconds);
    let bucket = this.#sources.get(source);
    if (bucket) {
      if (bucket.window !== window) {
        bucket.window = window;
        bucket.failures = 0;
      }
      this.#touch(source, bucket);
      if (bucket.failures >= this.#sourceLimit)
        return {
          retryAfter: Math.max(
            1,
            Math.ceil((window + 1) * this.#windowSeconds - now),
          ),
        };
      if (bucket.failures + bucket.inFlight >= this.#sourceLimit)
        return { retryAfter: 1 };
    } else {
      while (this.#sources.size >= this.#maxSources) {
        const evictable = [...this.#sources].find(
          ([, candidate]) => candidate.inFlight === 0,
        )?.[0];
        if (evictable === undefined) return { retryAfter: 1 };
        this.#sources.delete(evictable);
      }
      bucket = { window, failures: 0, inFlight: 0 };
    }
    bucket.inFlight++;
    this.#touch(source, bucket);
    const reservation = Object.freeze({ source });
    this.#reservations.add(reservation);
    return { reservation };
  }

  settle(
    reservation: AuthAttemptReservation,
    authenticationFailed: boolean,
  ): void {
    if (!this.#reservations.delete(reservation)) return;
    const bucket = this.#sources.get(reservation.source);
    if (!bucket || bucket.inFlight <= 0) return;
    const window = Math.floor(this.#clock() / this.#windowSeconds);
    if (bucket.window !== window) {
      bucket.window = window;
      bucket.failures = 0;
    }
    bucket.inFlight--;
    if (authenticationFailed) bucket.failures++;
    if (!bucket.failures && !bucket.inFlight)
      this.#sources.delete(reservation.source);
    else this.#touch(reservation.source, bucket);
  }

  get trackedSources(): readonly string[] {
    return Object.freeze([...this.#sources.keys()]);
  }
  #touch(source: string, bucket: FailureBucket): void {
    this.#sources.delete(source);
    this.#sources.set(source, bucket);
  }
}
