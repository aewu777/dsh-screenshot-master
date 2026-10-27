/**
 * Error taxonomy for the screenshot plugin.
 *
 * Every failure that can reach a model is a `ScreenshotError` with a stable
 * machine-readable `code` and a message that says what the caller can do next.
 * Codes are part of the public contract: the tools surface them verbatim.
 */

export type ScreenshotErrorCode =
  /** The current operating system has no capture backend. */
  | 'UNSUPPORTED_PLATFORM'
  /** A parameter was missing, malformed, or out of range. */
  | 'INVALID_ARGUMENT'
  /** The requested display index or identifier does not exist. */
  | 'DISPLAY_NOT_FOUND'
  /** The requested window identifier is not a live window any more. */
  | 'WINDOW_NOT_FOUND'
  /** The window exists but the native API refused to produce content for it. */
  | 'WINDOW_NOT_CAPTURABLE'
  /** The window is minimized and has no composited surface to read. */
  | 'WINDOW_MINIMIZED'
  /** macOS Screen Recording permission is missing or was declined. */
  | 'PERMISSION_DENIED'
  /** The native capture layer ran but produced nothing usable. */
  | 'CAPTURE_FAILED'
  /** The captured bitmap has no visual content (a uniform image). */
  | 'BLANK_CAPTURE'
  /** The screenshot could not be written to the requested directory. */
  | 'OUTPUT_WRITE_FAILED'
  /** The file that was written is not a decodable PNG. */
  | 'INVALID_PNG'
  /** The macOS native helper is missing, not executable, or failed to start. */
  | 'NATIVE_HELPER_UNAVAILABLE'
  /** A native command exceeded its time budget. */
  | 'TIMEOUT'
  /** Anything that does not fit above. */
  | 'INTERNAL_ERROR'

export interface ScreenshotErrorOptions {
  /** Actionable follow-up for the caller or the human reading the message. */
  hint?: string
  /** Diagnostic payload; kept out of the model-facing message by default. */
  details?: Record<string, unknown>
  cause?: unknown
}

export class ScreenshotError extends Error {
  readonly code: ScreenshotErrorCode
  readonly hint: string | undefined
  readonly details: Record<string, unknown> | undefined

  constructor(code: ScreenshotErrorCode, message: string, options: ScreenshotErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ScreenshotError'
    this.code = code
    this.hint = options.hint
    this.details = options.details
  }

  /** Message plus the actionable hint, used for model-facing tool output. */
  toMessage(): string {
    return this.hint ? `${this.message} ${this.hint}` : this.message
  }
}

export function isScreenshotError(value: unknown): value is ScreenshotError {
  return value instanceof ScreenshotError
}

/**
 * Convert anything thrown into a `ScreenshotError`.
 *
 * Node filesystem errors are mapped onto the matching plugin code so that the
 * caller never has to guess an `errno` string.
 */
export function toScreenshotError(error: unknown, fallbackCode: ScreenshotErrorCode = 'INTERNAL_ERROR'): ScreenshotError {
  if (isScreenshotError(error)) return error

  const errno = (error as NodeJS.ErrnoException | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)

  switch (errno) {
    case 'EACCES':
    case 'EPERM':
      return new ScreenshotError('OUTPUT_WRITE_FAILED', `Permission denied while writing the screenshot: ${message}`, {
        hint: 'Choose an output directory the current user can write to, or fix its permissions.',
        cause: error,
      })
    case 'ENOSPC':
      return new ScreenshotError('OUTPUT_WRITE_FAILED', `The output volume is full: ${message}`, {
        hint: 'Free disk space or configure a different output directory.',
        cause: error,
      })
    case 'ENOENT':
      return new ScreenshotError('OUTPUT_WRITE_FAILED', `A path required for the screenshot does not exist: ${message}`, {
        cause: error,
      })
    case 'EROFS':
      return new ScreenshotError('OUTPUT_WRITE_FAILED', `The output directory is on a read-only filesystem: ${message}`, {
        cause: error,
      })
    case 'EEXIST':
      return new ScreenshotError('OUTPUT_WRITE_FAILED', `Refusing to overwrite an existing file: ${message}`, {
        cause: error,
      })
    default:
      return new ScreenshotError(fallbackCode, message, { cause: error })
  }
}

/** Short, stable description used by tool results and logs. */
export function errorInfo(error: unknown): { code: ScreenshotErrorCode; message: string } {
  const normalized = toScreenshotError(error)
  return { code: normalized.code, message: normalized.toMessage() }
}
