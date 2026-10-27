/**
 * Mapping from a native program's structured error onto the plugin's error
 * taxonomy.
 *
 * Both backends drive a program that prints
 * `{"ok":false,"error":{"code":"...","message":"..."}}`, so the mapping lives in
 * one place and stays identical across platforms.
 */

import { ScreenshotError, type ScreenshotErrorCode } from '../errors.js'

const KNOWN_CODES: readonly ScreenshotErrorCode[] = [
  'UNSUPPORTED_PLATFORM',
  'INVALID_ARGUMENT',
  'DISPLAY_NOT_FOUND',
  'WINDOW_NOT_FOUND',
  'WINDOW_NOT_CAPTURABLE',
  'WINDOW_MINIMIZED',
  'PERMISSION_DENIED',
  'CAPTURE_FAILED',
  'BLANK_CAPTURE',
  'OUTPUT_WRITE_FAILED',
  'INVALID_PNG',
  'NATIVE_HELPER_UNAVAILABLE',
  'TIMEOUT',
  'INTERNAL_ERROR',
]

const HINTS: Partial<Record<ScreenshotErrorCode, string>> = {
  INVALID_ARGUMENT: 'Pass an identifier exactly as list_windows returned it.',
  DISPLAY_NOT_FOUND: 'Call list_windows to see the available display indices.',
  WINDOW_NOT_FOUND:
    'The window was closed or re-created. Call list_windows again to get a fresh identifier.',
  WINDOW_NOT_CAPTURABLE:
    'The window exposes no capturable surface: it may be protected content, hardware accelerated, hidden, or on another Space.',
  WINDOW_MINIMIZED: 'Restore the window and try again.',
  PERMISSION_DENIED:
    'Grant Screen Recording permission to the app running DeepSeek Harness in System Settings > Privacy & Security, then restart it.',
  OUTPUT_WRITE_FAILED: 'Check the output directory permissions and free disk space.',
  CAPTURE_FAILED: 'Retry, or choose a different capture target.',
  BLANK_CAPTURE: 'The captured content was empty; retry or choose a different capture target.',
  INVALID_PNG: 'The native capture did not produce a decodable PNG; retry the capture.',
  NATIVE_HELPER_UNAVAILABLE: 'Build or install the native helper, then retry.',
  TIMEOUT: 'Increase `timeoutMs` or choose a target that is not busy.',
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/** Convert the `error` member of a native failure payload into a plugin error. */
export function structuredNativeFailure(error: unknown): ScreenshotError {
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>
    const rawCode = asString(record.code, 'CAPTURE_FAILED')
    const message = asString(record.message, 'The native capture program failed without a message.')
    const code = (KNOWN_CODES as readonly string[]).includes(rawCode)
      ? (rawCode as ScreenshotErrorCode)
      : 'CAPTURE_FAILED'
    const hint = HINTS[code]
    return new ScreenshotError(code, message, hint ? { hint } : {})
  }
  return new ScreenshotError('CAPTURE_FAILED', 'The native capture program failed without a structured error.')
}
