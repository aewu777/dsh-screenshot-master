/**
 * macOS capture backend.
 *
 * Primary mechanism: the bundled ScreenCaptureKit helper
 * (`native/macos/DSHScreenshotHelper.swift`), which enumerates shareable content
 * and captures still images with `SCScreenshotManager` on macOS 14+.
 *
 * Documented fallback: if the helper binary has not been built, a full-screen
 * capture is performed with `/usr/sbin/screencapture`. That path cannot
 * enumerate windows and cannot select a display, so it is reported explicitly
 * rather than being mistaken for full functionality. Window capture through the
 * fallback is only possible with a CGWindowID the user already knows.
 *
 * Nothing here silently substitutes a display capture for a window capture.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ScreenshotConfig } from '../config.js'
import { ScreenshotError } from '../errors.js'
import { structuredNativeFailure } from './native-error.js'
import {
  createProcessRunner,
  parseJsonLine,
  type ProcessRunner,
  type RunResult,
} from './process.js'
import type {
  Bounds,
  CaptureMethod,
  CaptureOutcome,
  DisplayInfo,
  ListTargetsResult,
  ScreenBackend,
  WindowInfo,
} from './types.js'

/** Compiled helper location; `scripts/build-macos-helper.sh` writes it there. */
export const DEFAULT_HELPER_PATH = fileURLToPath(
  new URL('../../native/macos/build/dsh-screenshot-helper', import.meta.url),
)

export const HELPER_BUILD_COMMAND = 'npm run build:native:macos'

export const DEFAULT_SCREENCAPTURE_PATH = '/usr/sbin/screencapture'

export interface MacosBackendOptions {
  runner?: ProcessRunner
  /** Explicit helper binary; empty means "not built". */
  helperPath?: string
  screencapturePath?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Injected filesystem probe so path resolution is testable on any OS. */
  exists?: (path: string) => boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScreenshotError('CAPTURE_FAILED', 'The macOS capture helper returned a malformed payload.')
  }
  return value as Record<string, unknown>
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function parseBounds(value: unknown): Bounds {
  const record = value && typeof value === 'object' ? asRecord(value) : {}
  return {
    x: asNumber(record.x, 0),
    y: asNumber(record.y, 0),
    width: asNumber(record.width, 0),
    height: asNumber(record.height, 0),
  }
}

export function parseMacosDisplay(value: unknown): DisplayInfo {
  const record = asRecord(value)
  return {
    index: asNumber(record.index, 0),
    id: asString(record.id),
    name: asString(record.name, asString(record.id)),
    primary: asBoolean(record.primary),
    width: asNumber(record.width, 0),
    height: asNumber(record.height, 0),
    scaleFactor: asNumber(record.scaleFactor, 1),
    bounds: parseBounds(record.bounds),
  }
}

export function parseMacosWindow(value: unknown): WindowInfo {
  const record = asRecord(value)
  const displayIndex = record.displayIndex
  const minimized = record.minimized
  return {
    id: asString(record.id),
    title: asString(record.title),
    app: asString(record.app),
    pid: asNumber(record.pid, 0),
    bounds: parseBounds(record.bounds),
    onScreen: asBoolean(record.onScreen, true),
    foreground: asBoolean(record.foreground),
    // ScreenCaptureKit cannot distinguish a minimized window from an off-screen
    // one, so the field is left undefined instead of being guessed.
    ...(typeof minimized === 'boolean' ? { minimized } : {}),
    ...(typeof displayIndex === 'number' && Number.isFinite(displayIndex) ? { displayIndex } : {}),
  }
}

/** Parse the JSON printed by `dsh-screenshot-helper list`. */
export function parseMacosListPayload(payload: unknown): ListTargetsResult {
  const record = asRecord(payload)
  if (record.ok !== true) throw structuredNativeFailure(record.error)
  return {
    windows: Array.isArray(record.windows) ? record.windows.map(parseMacosWindow) : [],
    displays: Array.isArray(record.displays) ? record.displays.map(parseMacosDisplay) : [],
    notes: Array.isArray(record.notes)
      ? record.notes.filter((note): note is string => typeof note === 'string')
      : [],
  }
}

/** Parse the JSON printed by `capture-screen` / `capture-window`. */
export function parseMacosCapturePayload(payload: unknown, strategy: 'native' | 'desktop'): CaptureOutcome {
  const record = asRecord(payload)
  if (record.ok !== true) throw structuredNativeFailure(record.error)

  const method = asString(record.method, 'screencapturekit')
  if (method !== 'screencapturekit' && method !== 'screencapture-cli') {
    throw new ScreenshotError(
      'CAPTURE_FAILED',
      `The macOS helper reported an unknown capture method ${JSON.stringify(method)}.`,
    )
  }

  const outcome: CaptureOutcome = {
    method: method as CaptureMethod,
    notes: Array.isArray(record.notes)
      ? record.notes.filter((note): note is string => typeof note === 'string')
      : [],
    fallback: strategy === 'desktop',
  }
  if (typeof record.width === 'number') outcome.width = record.width
  if (typeof record.height === 'number') outcome.height = record.height

  if (Array.isArray(record.displays)) {
    const displays = record.displays.map(parseMacosDisplay)
    const index = asNumber(record.displayIndex, -1)
    const selected = displays.find((display) => display.index === index) ?? displays[0]
    if (selected) outcome.display = selected
  }
  if (record.window !== null && record.window !== undefined) {
    outcome.window = parseMacosWindow(record.window)
  }
  return outcome
}

/** `mac:123` or `123` -> 123. */
export function parseMacosWindowId(windowId: string): number {
  const match = /^(?:mac:)?(\d+)$/.exec(windowId.trim())
  if (!match) {
    throw new ScreenshotError(
      'INVALID_ARGUMENT',
      `'${windowId}' is not a macOS window identifier (expected 'mac:<window-id>').`,
      { hint: 'Call list_windows and pass one of the returned `id` values.' },
    )
  }
  return Number(match[1])
}

/** Resolve the helper binary, or `undefined` when it has not been built. */
export function resolveHelperPath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const candidates = [explicit, env.DSH_SCREENSHOT_MACOS_HELPER, DEFAULT_HELPER_PATH]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() && exists(candidate)) {
      return candidate
    }
  }
  return undefined
}

export function helperMissingError(): ScreenshotError {
  return new ScreenshotError(
    'NATIVE_HELPER_UNAVAILABLE',
    `The macOS ScreenCaptureKit helper is not available at ${DEFAULT_HELPER_PATH}.`,
    {
      hint: `Build it once with \`${HELPER_BUILD_COMMAND}\` (requires the Xcode command line tools), or set \`macosHelperPath\`. Full-screen capture falls back to the system screencapture utility; window enumeration needs the helper.`,
    },
  )
}

function helperRunFailure(result: RunResult, helperPath: string): ScreenshotError {
  if (result.spawnError) {
    return new ScreenshotError(
      'NATIVE_HELPER_UNAVAILABLE',
      `The macOS capture helper could not be executed: ${result.spawnError.message}`,
      {
        hint: `Rebuild it with \`${HELPER_BUILD_COMMAND}\`; on Apple silicon the binary must be built for arm64, and it must stay executable (chmod +x).`,
        details: { helperPath },
      },
    )
  }
  if (result.timedOut) {
    return new ScreenshotError(
      'TIMEOUT',
      'The macOS capture helper exceeded its time budget. It waits for the Screen Recording permission prompt, which may be blocking it.',
      { hint: 'Answer the macOS permission prompt, or increase `timeoutMs`.' },
    )
  }
  const stderr = result.stderr.trim()
  return new ScreenshotError(
    'CAPTURE_FAILED',
    `The macOS capture helper exited with code ${String(result.code)}${stderr ? `: ${stderr}` : '.'}`,
  )
}

export interface MacosBackend extends ScreenBackend {
  /** True when the ScreenCaptureKit helper was found. */
  readonly hasNativeHelper: boolean
}

export function createMacosBackend(options: MacosBackendOptions = {}): MacosBackend {
  const runner = options.runner ?? createProcessRunner()
  const timeoutMs = options.timeoutMs ?? 30_000
  const env = options.env ?? process.env
  const screencapture = options.screencapturePath ?? DEFAULT_SCREENCAPTURE_PATH
  const helperPath = resolveHelperPath(options.helperPath, env, options.exists ?? existsSync)

  async function runHelper(args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!helperPath) throw helperMissingError()
    const result = await runner({
      command: helperPath,
      args,
      timeoutMs,
      ...(signal ? { signal } : {}),
      env,
    })
    const payload = parseJsonLine<unknown>(result.stdout)
    if (payload === undefined) throw helperRunFailure(result, helperPath)
    const record = asRecord(payload)
    if (record.ok !== true) throw structuredNativeFailure(record.error)
    return record
  }

  async function runScreencapture(args: string[], signal?: AbortSignal): Promise<void> {
    const result = await runner({
      command: screencapture,
      args,
      timeoutMs,
      ...(signal ? { signal } : {}),
      env,
    })
    if (result.spawnError) {
      throw new ScreenshotError(
        'NATIVE_HELPER_UNAVAILABLE',
        `The system screencapture utility could not be executed: ${result.spawnError.message}`,
        { hint: `Expected it at ${screencapture}.` },
      )
    }
    if (result.timedOut) {
      throw new ScreenshotError('TIMEOUT', 'The screencapture utility exceeded its time budget.', {
        hint: 'Answer the macOS permission prompt, or increase `timeoutMs`.',
      })
    }
    if (result.code !== 0) {
      const stderr = result.stderr.trim()
      throw new ScreenshotError(
        'CAPTURE_FAILED',
        `screencapture exited with code ${String(result.code)}${stderr ? `: ${stderr}` : '.'}`,
        {
          hint: 'macOS may be waiting for Screen Recording permission. Grant it to the app running DeepSeek Harness, then retry.',
        },
      )
    }
  }

  return {
    platform: 'darwin',
    displayName: helperPath
      ? 'macOS (ScreenCaptureKit helper)'
      : 'macOS (screencapture fallback, no window enumeration)',
    supportsDesktopWindowFallback: false,
    hasNativeHelper: Boolean(helperPath),

    async listTargets(listOptions = {}) {
      const record = await runHelper(['list'], listOptions.signal)
      return parseMacosListPayload(record)
    },

    async captureScreen(capture) {
      if (helperPath) {
        const args = ['capture-screen', '--out', capture.outPath]
        if (capture.display !== undefined) args.push('--display', String(capture.display))
        return parseMacosCapturePayload(await runHelper(args, capture.signal), 'native')
      }

      // Documented degraded mode: the system utility cannot select a display.
      if (capture.display !== undefined) {
        throw new ScreenshotError(
          'NATIVE_HELPER_UNAVAILABLE',
          'Selecting a specific display requires the native ScreenCaptureKit helper.',
          { hint: `Build the helper with \`${HELPER_BUILD_COMMAND}\`, or omit \`display\` to capture the main display.` },
        )
      }
      await runScreencapture(['-x', '-t', 'png', capture.outPath], capture.signal)
      return {
        method: 'screencapture-cli',
        notes: [
          'Captured with /usr/sbin/screencapture because the ScreenCaptureKit helper was not found; this captures the main display only.',
        ],
        fallback: true,
      }
    },

    async captureWindow(capture) {
      if (capture.strategy === 'desktop') {
        // Never fabricate a window image from the desktop on macOS: the native
        // path is required so the result is provably the requested window.
        throw new ScreenshotError(
          'WINDOW_NOT_CAPTURABLE',
          'The macOS backend does not implement a desktop-region window fallback.',
        )
      }

      const windowId = parseMacosWindowId(capture.windowId)
      if (helperPath) {
        return parseMacosCapturePayload(
          await runHelper(['capture-window', '--out', capture.outPath, '--id', String(windowId)], capture.signal),
          'native',
        )
      }

      await runScreencapture(
        ['-x', '-o', '-t', 'png', '-l', String(windowId), capture.outPath],
        capture.signal,
      )
      return {
        method: 'screencapture-cli',
        notes: [
          'Captured with /usr/sbin/screencapture because the ScreenCaptureKit helper was not found.',
        ],
        fallback: true,
      }
    },
  }
}

export function createMacosBackendFromConfig(config: ScreenshotConfig): ScreenBackend {
  return createMacosBackend({
    ...(config.macosHelperPath ? { helperPath: config.macosHelperPath } : {}),
    timeoutMs: config.timeoutMs,
  })
}
