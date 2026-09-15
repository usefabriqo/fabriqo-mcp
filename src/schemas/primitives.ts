import { z } from 'zod';

export const MAX_DATABASE_ID = 2_147_483_647;
export const DEFAULT_PAGE_SIZE = 25;

// Python's str.strip includes these whitespace code points (but not U+FEFF).
const surroundingWhitespace =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Required Python whitespace normalization includes these code points.
  /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
export const strip = (value: string): string =>
  value.replace(surroundingWhitespace, '');

/** Lengths are Unicode code points, as in Pydantic and JSON Schema. */
export function text(max: number, min = 0) {
  return z
    .string()
    .overwrite(strip)
    .superRefine((value, ctx) => {
      const length = [...value].length;
      if (length < min || length > max) {
        ctx.addIssue({
          code: 'custom',
          message: `String must contain ${min}–${max} characters.`,
        });
      }
    })
    .meta({ ...(min ? { minLength: min } : {}), maxLength: max });
}

function parseInteger(value: unknown): unknown {
  if (typeof value === 'boolean') return Number(value);
  if (typeof value !== 'string') return value;
  const normalized = strip(value);
  return /^[+-]?\d+(?:_\d+)*(?:\.0+)?$/.test(normalized)
    ? Number(normalized.replaceAll('_', ''))
    : value;
}

// Preserve Pydantic's runtime coercions without advertising them to models.
export function integer(min: number, max: number) {
  return z
    .preprocess(parseInteger, z.number().int().min(min).max(max))
    .meta({ type: 'integer', minimum: min, maximum: max });
}

export const DatabaseId = integer(1, MAX_DATABASE_ID);
export const PageLimit = integer(1, 100);
export const HorizonDays = integer(1, 365);
export const LeadTimeDays = integer(0, MAX_DATABASE_ID);
export const Cursor = text(200);
export const IdempotencyKey = text(200, 1);

export const BooleanInput = z
  .preprocess((value: unknown) => {
    if (value === 1) return true;
    if (value === 0) return false;
    if (typeof value === 'string') {
      if (['1', 'true', 't', 'yes', 'y', 'on'].includes(value.toLowerCase()))
        return true;
      if (['0', 'false', 'f', 'no', 'n', 'off'].includes(value.toLowerCase()))
        return false;
    }
    return value;
  }, z.boolean())
  .meta({ type: 'boolean' });

interface DecimalParts {
  digits: string;
  exponent: number;
  negative: boolean;
}

function asciiDecimalDigits(value: string): string {
  return value.replace(/\p{Decimal_Number}/gu, (digit) => {
    if (/\d/.test(digit)) return digit;
    const point = digit.codePointAt(0) ?? 0;
    let start = point;
    while (
      start > 0 &&
      /\p{Decimal_Number}/u.test(String.fromCodePoint(start - 1))
    )
      start--;
    return String((point - start) % 10);
  });
}

function decimalParts(value: string | number): DecimalParts | undefined {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(
    asciiDecimalDigits(strip(String(value)).replaceAll('_', '')),
  );
  if (!match) return undefined;
  const fraction = match[3] ?? match[4] ?? '';
  const exponent = Number(match[5] ?? '0') - fraction.length;
  if (!Number.isSafeInteger(exponent)) return undefined;
  return {
    digits: `${match[2] ?? ''}${fraction}`.replace(/^0+/, '') || '0',
    exponent,
    negative: match[1] === '-',
  };
}

/** Decimal JSON serialization retains exact supplied decimal precision. */
function formatDecimal({ digits, exponent, negative }: DecimalParts): string {
  const sign = negative ? '-' : '';
  const adjusted = exponent + digits.length - 1;
  if (exponent > 0 || adjusted < -6) {
    const coefficient =
      digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${coefficient}E${adjusted >= 0 ? '+' : ''}${adjusted}`;
  }
  if (exponent === 0) return sign + digits;
  const point = digits.length + exponent;
  return point > 0
    ? `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
    : `${sign}0.${'0'.repeat(-point)}${digits}`;
}

/** Check decimal constraints without rounding through JavaScript floating point. */
function decimal(
  maxDigits: number,
  minimum?: 'positive' | 'nonnegative',
  max?: number,
) {
  const numeric = z.number();
  const boundedNumeric =
    minimum === 'positive'
      ? numeric.positive()
      : minimum === 'nonnegative'
        ? numeric.nonnegative()
        : numeric;
  const input = z.union([
    max === undefined ? boundedNumeric : boundedNumeric.max(max),
    z.string(),
  ]);
  return input
    .transform((value, ctx) => {
      const parts = decimalParts(value);
      let message: string | undefined;
      if (!parts) message = 'Input should be a finite decimal.';
      else {
        const nonzero = parts.digits !== '0';
        const normalized = parts.digits.replace(/0+$/, '');
        const exponent =
          parts.exponent + parts.digits.length - normalized.length;
        const places = Math.max(0, -exponent);
        const whole = Math.max(0, normalized.length + exponent);
        if (
          nonzero &&
          (places > 4 || whole > maxDigits - 4 || whole + places > maxDigits)
        ) {
          message = `Decimal must have at most ${maxDigits} digits, including at most 4 decimal places.`;
        } else if (
          (minimum === 'positive' && (!nonzero || parts.negative)) ||
          (minimum === 'nonnegative' && nonzero && parts.negative)
        ) {
          message =
            minimum === 'positive'
              ? 'Value must be greater than zero.'
              : 'Value must be nonnegative.';
        } else if (max !== undefined && Number(formatDecimal(parts)) > max) {
          message = `Value must be at most ${max}.`;
        }
      }
      if (message || !parts) {
        ctx.addIssue({
          code: 'custom',
          message: message ?? 'Invalid decimal.',
        });
        return z.NEVER;
      }
      return formatDecimal(parts);
    })
    .pipe(z.string());
}

export const Decimal14x4 = decimal(14);
export const PositiveDecimal14x4 = decimal(14, 'positive');
export const NonNegativeDecimal14x4 = decimal(14, 'nonnegative');
export const NonNegativeDecimal8x4 = decimal(8, 'nonnegative');
export const PercentageDecimal8x4 = decimal(8, 'nonnegative', 100);

function isValidDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1)
    return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    day <=
    ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ??
      0)
  );
}

function timestamp(value: unknown): string | undefined {
  if (
    typeof value !== 'number' &&
    !(typeof value === 'string' && /^[+-]?\d+(?:\.\d*)?$/.test(value))
  )
    return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const whole = Math.floor(numeric);
  const isMilliseconds = Math.abs(whole) > 20_000_000_000;
  let seconds = isMilliseconds ? Math.floor(whole / 1000) : whole;
  let micros = isMilliseconds ? (((whole % 1000) + 1000) % 1000) * 1000 : 0;
  const fractionScale = Math.abs(numeric) > 20_000_000_000 ? 1000 : 1_000_000;
  const fraction = Math.abs(numeric % 1);
  // Pydantic handles negative JSON numbers and negative timestamp strings
  // differently. Retain that behavior while preserving microsecond precision.
  const fractionMicros = Math.round(fraction * fractionScale);
  micros +=
    typeof value === 'string' && numeric < 0 && fraction !== 0
      ? fractionScale - fractionMicros
      : fractionMicros;
  seconds += Math.floor(micros / 1_000_000);
  micros %= 1_000_000;
  const date = new Date(seconds * 1000);
  if (
    !Number.isFinite(date.valueOf()) ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  )
    return undefined;
  return (
    date.toISOString().slice(0, 19) +
    (micros ? `.${String(micros).padStart(6, '0')}` : '') +
    'Z'
  );
}

function datetime(value: unknown, timezoneRequired = true): string | undefined {
  const fromTimestamp = timestamp(value);
  if (fromTimestamp !== undefined) return fromTimestamp;
  if (typeof value !== 'string') return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt _](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?([Zz]|[+-]\d{2}:?\d{2})?$/.exec(
      value,
    );
  if (!match || (timezoneRequired && !match[8])) return undefined;
  if (
    !isValidDate(Number(match[1]), Number(match[2]), Number(match[3])) ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6] ?? '0') > 59
  )
    return undefined;
  const rawZone = match[8] ?? '';
  let zone = rawZone.toUpperCase();
  if (zone && zone !== 'Z') {
    const offset = zone.replace(':', '');
    if (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(3)) > 59)
      return undefined;
    zone =
      Number(offset.slice(1)) === 0
        ? 'Z'
        : `${offset.slice(0, 3)}:${offset.slice(3)}`;
  }
  const fraction = (match[7] ?? '').slice(0, 6).padEnd(6, '0');
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}${fraction === '000000' ? '' : `.${fraction}`}${zone}`;
}

export const AwareDatetime = z
  .preprocess(
    (value: unknown) => datetime(value) ?? value,
    z
      .string()
      .refine(
        (value) => datetime(value) !== undefined,
        'A valid timezone-aware datetime is required.',
      ),
  )
  .meta({ type: 'string', format: 'date-time' });

export const DateInput = z
  .preprocess(
    (value: unknown) => {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
        return value;
      const dateTime = datetime(value, false);
      return dateTime && /^.{10}T00:00:00(?:Z|[+-]\d{2}:\d{2})?$/.test(dateTime)
        ? dateTime.slice(0, 10)
        : value;
    },
    z.string().refine((value) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      return (
        !!match &&
        isValidDate(Number(match[1]), Number(match[2]), Number(match[3]))
      );
    }, 'A valid date in YYYY-MM-DD format is required.'),
  )
  .meta({ type: 'string', format: 'date' });
