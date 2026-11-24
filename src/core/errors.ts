/**
 * Every failure ShopShift can explain is a ShopShiftError: a stable code for automation, a message
 * for humans, and, wherever possible, a hint that says what to do next.
 */
export type ErrorCode =
  | 'USAGE'
  | 'VALIDATION'
  | 'CONFIG_INVALID'
  | 'CONFIG_LOCKED'
  | 'CONFIG_VERSION'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_EXISTS'
  | 'ACCOUNT_IN_USE'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_EXISTS'
  | 'WORKSPACE_AMBIGUOUS'
  | 'WORKSPACE_UNRESOLVED'
  | 'DIRECTORY_INVALID'
  | 'SHOPIFY_NOT_FOUND'
  | 'SHOPIFY_UNSUPPORTED'
  | 'SHOPIFY_FAILED'
  | 'AUTH_MISSING'
  | 'AUTH_EXPIRED'
  | 'PORT_IN_USE'
  | 'SESSION_CONFLICT'
  | 'CONTEXT_CONFLICT'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_NOT_FOUND'
  | 'LIVE_NOT_CONFIRMED'
  | 'BLOCKED'
  | 'NOT_CONFIRMED'
  | 'INTERACTIVE_REQUIRED'
  | 'EDITOR_NOT_FOUND'
  | 'OPEN_FAILED'
  | 'CANCELLED';

/** Process exit codes, documented in the README. */
const EXIT_CODES: Partial<Record<ErrorCode, number>> = {
  USAGE: 2,
  VALIDATION: 2,
  INTERACTIVE_REQUIRED: 2,
  WORKSPACE_AMBIGUOUS: 3,
  WORKSPACE_UNRESOLVED: 3,
  WORKSPACE_NOT_FOUND: 3,
  AUTH_MISSING: 4,
  AUTH_EXPIRED: 4,
  CONTEXT_CONFLICT: 5,
  TARGET_AMBIGUOUS: 5,
  TARGET_NOT_FOUND: 5,
  LIVE_NOT_CONFIRMED: 5,
  BLOCKED: 5,
  NOT_CONFIRMED: 5,
  SESSION_CONFLICT: 5,
  PORT_IN_USE: 6,
  SHOPIFY_NOT_FOUND: 127,
  CANCELLED: 130,
};

export interface ShopShiftErrorOptions {
  hint?: string | undefined;
  details?: readonly string[];
  cause?: unknown;
}

export class ShopShiftError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: readonly string[];

  constructor(code: ErrorCode, message: string, options: ShopShiftErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ShopShiftError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details ?? [];
  }

  get exitCode(): number {
    return EXIT_CODES[this.code] ?? 1;
  }

  toJSON(): { code: ErrorCode; message: string; hint?: string; details?: readonly string[] } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details.length === 0 ? {} : { details: this.details }),
    };
  }
}

export class CancelledError extends ShopShiftError {
  constructor(message = 'Cancelled. Nothing was changed.') {
    super('CANCELLED', message);
    this.name = 'CancelledError';
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:shp(?:at|ca|pa|ss|tka|ua)|atkn|shptka)_[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+/g,
];

/** Strips anything token-shaped. Applied to all text ShopShift relays from another process. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, '[redacted]'), text);
}
