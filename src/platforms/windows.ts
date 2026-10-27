/**
 * Windows capture backend.
 *
 * The native work happens in `scripts/windows/*.ps1`: Win32 interop is not
 * reachable from Node.js without a compiled addon, and PowerShell 5.1 ships with
 * every supported Windows version. This module owns the contract with those
 * scripts: how they are invoked, how their single JSON line is parsed, and how
 * their failures map onto the plugin's error codes.
 *
 * Capture chain for a window (see the script header for details):
 *   PrintWindow(PW_RENDERFULLCONTENT) -> PrintWindow(0) -> BitBlt ->
 *   desktop-region copy. A window that yields nothing at all is reported as
 *   `WINDOW_NOT_CAPTURABLE` or `BLANK_CAPTURE`, never as a success.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScreenshotError } from '../errors.js'
import type { ScreenshotConfig } from '../config.js'
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

/** Directory that holds the `.ps1` scripts, resolved next to the compiled module. */
export const DEFAULT_SCRIPT_DIR = fileURLToPath(new URL('./scripts/windows', import.meta.url))

export interface WindowsBackendOptions {
  /** Overrides the subprocess implementation; used by unit tests. */
  runner?: ProcessRunner
  /** Overrides the script directory; used by unit tests. */
  scriptDir?: string
  /** Explicit PowerShell executable. */
  powershellPath?: string
  /** Time budget for one script invocation. */
  timeoutMs?: number
  /** Environment used when running the scripts. */
  env?: NodeJS.ProcessEnv
}

const WINDOW_METHODS: readonly CaptureMethod[] = [
  'copyfromscreen',
  'printwindow',
  'bitblt',
  'desktop-region',
]

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScreenshotError('CAPTURE_FAILED', 'The Windows capture script returned a malformed payload.')
  }
  return value as Record<string, unknown>
}

function asNumber(value: unknown, field: string, fallback?: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (fallback !== undefined) return fallback
  throw new ScreenshotError('CAPTURE_FAILED', `The Windows capture script returned no numeric \`${field}\`.`)
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function parseBounds(value: unknown): Bounds {
  const record = asRecord(value)
  return {
    x: asNumber(record.x, 'bounds.x', 0),
    y: asNumber(record.y, 'bounds.y', 0),
    width: asNumber(record.width, 'bounds.width', 0),
    height: asNumber(record.height, 'bounds.height', 0),
  }
}

function parseDisplay(value: unknown): DisplayInfo {
  const record = asRecord(value)
  return {
    index: asNumber(record.index, 'display.index', 0),
    id: asString(record.id),
    name: asString(record.name, asString(record.id)),
    primary: asBoolean(record.primary),
    width: asNumber(record.width, 'display.width', 0),
    height: asNumber(record.height, 'display.height', 0),
    scaleFactor: asNumber(record.scaleFactor, 'display.scaleFactor', 1),
    bounds: parseBounds(record.bounds ?? {}),
  }
}

function parseWindow(value: unknown): WindowInfo {
  const record = asRecord(value)
  const displayIndex = record.displayIndex
  return {
    id: asString(record.id),
    title: asString(record.title),
    app: asString(record.app),
    pid: asNumber(record.pid, 'window.pid', 0),
    bounds: parseBounds(record.bounds ?? {}),
    minimized: asBoolean(record.minimized),
    onScreen: asBoolean(record.onScreen, true),
    foreground: asBoolean(record.foreground),
    ...(typeof displayIndex === 'number' && Number.isFinite(displayIndex) ? { displayIndex } : {}),
  }
}

/** Parse the payload printed by `list-windows.ps1`. */
export function parseWindowListPayload(payload: unknown): ListTargetsResult {
  const record = asRecord(payload)
  if (record.ok !== true) {
    throw nativeFailure(record.error)
  }
  const windows = Array.isArray(record.windows) ? record.windows.map(parseWindow) : []
  const displays = Array.isArray(record.displays) ? record.displays.map(parseDisplay) : []
  const notes = Array.isArray(record.notes) ? record.notes.filter((note): note is string => typeof note === 'string') : []
  return { windows, displays, notes }
}

/** Parse the payload printed by `capture.ps1`. */
export function parseCapturePayload(payload: unknown, strategy: 'native' | 'desktop'): CaptureOutcome {
  const record = asRecord(payload)
  if (record.ok !== true) {
    throw nativeFailure(record.error)
  }

  const method = asString(record.method)
  if (!WINDOW_METHODS.includes(method as CaptureMethod)) {
    throw new ScreenshotError(
      'CAPTURE_FAILED',
      `The Windows capture script reported an unknown capture method ${JSON.stringify(method)}.`,
    )
  }

  const notes = Array.isArray(record.notes) ? record.notes.filter((note): note is string => typeof note === 'string') : []
  const outcome: CaptureOutcome = {
    width: asNumber(record.width, 'width', 0),
    height: asNumber(record.height, 'height', 0),
    method: method as CaptureMethod,
    notes,
    fallback: strategy === 'desktop',
  }
  if (record.display !== null && record.display !== undefined) {
    outcome.display = parseDisplay(record.display)
  }
  if (record.window !== null && record.window !== undefined) {
    outcome.window = parseWindow(record.window)
  }
  return outcome
}

/** Turn a structured script error into a typed plugin error. */
export const nativeFailure = structuredNativeFailure

/** Resolve the PowerShell executable to use. */
export function resolvePowerShellPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit && explicit.trim()) return explicit.trim()
  const override = env.DSH_SCREENSHOT_POWERSHELL?.trim()
  if (override) return override
  const systemRoot = env.SystemRoot ?? env.windir
  if (systemRoot) {
    return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }
  return 'powershell.exe'
}

/** Map a failed script run onto a plugin error before parsing any output. */
export function runnerFailure(result: RunResult): ScreenshotError {
  if (result.spawnError) {
    return new ScreenshotError(
      'NATIVE_HELPER_UNAVAILABLE',
      `PowerShell could not be started: ${result.spawnError.message}`,
      { hint: 'Install Windows PowerShell 5.1 or point `powershellPath` at a working powershell.exe.' },
    )
  }
  if (result.timedOut) {
    return new ScreenshotError('TIMEOUT', 'The Windows capture script exceeded its time budget.', {
      hint: 'Increase `timeoutMs` or close the window that is not responding.',
    })
  }
  const stderr = result.stderr.trim()
  return new ScreenshotError(
    'CAPTURE_FAILED',
    `The Windows capture script exited with code ${String(result.code)}${stderr ? `: ${stderr}` : '.'}`,
  )
}

export function createWindowsBackend(options: WindowsBackendOptions = {}): ScreenBackend {
  const runner = options.runner ?? createProcessRunner()
  const scriptDir = options.scriptDir ?? DEFAULT_SCRIPT_DIR
  const timeoutMs = options.timeoutMs ?? 30_000
  const env = options.env ?? process.env
  const powershell = resolvePowerShellPath(options.powershellPath, env)

  async function runScript(
    script: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = await runner({
      command: powershell,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(scriptDir, script),
        ...args,
      ],
      timeoutMs,
      ...(signal ? { signal } : {}),
      env,
    })

    const payload = parseJsonLine<unknown>(result.stdout)
    if (payload === undefined) {
      // No JSON: the run failed before it could report anything structured.
      throw runnerFailure(result)
    }
    const record = asRecord(payload)
    if (record.ok !== true) throw nativeFailure(record.error)
    if (result.code !== 0) {
      throw new ScreenshotError(
        'CAPTURE_FAILED',
        `The Windows capture script reported success but exited with code ${String(result.code)}.`,
      )
    }
    return record
  }

  return {
    platform: 'win32',
    displayName: 'Windows (PrintWindow/BitBlt with desktop-region fallback)',
    supportsDesktopWindowFallback: true,

    async listTargets(listOptions = {}) {
      const record = await runScript(
        'list-windows.ps1',
        [],
        listOptions.signal,
      )
      return parseWindowListPayload(record)
    },

    async captureScreen(capture) {
      const args = ['-Mode', 'screen', '-Out', capture.outPath]
      if (capture.display !== undefined) args.push('-Display', String(capture.display))
      const record = await runScript('capture.ps1', args, capture.signal)
      return parseCapturePayload(record, 'native')
    },

    async captureWindow(capture) {
      const record = await runScript(
        'capture.ps1',
        [
          '-Mode',
          'window',
          '-WindowId',
          capture.windowId,
          '-Out',
          capture.outPath,
          '-Strategy',
          capture.strategy,
        ],
        capture.signal,
      )
      return parseCapturePayload(record, capture.strategy)
    },
  }
}

/** Build a backend honouring the resolved plugin configuration. */
export function createWindowsBackendFromConfig(config: ScreenshotConfig): ScreenBackend {
  return createWindowsBackend({
    ...(config.powershellPath ? { powershellPath: config.powershellPath } : {}),
    ...(config.windowsScriptDir ? { scriptDir: config.windowsScriptDir } : {}),
    timeoutMs: config.timeoutMs,
  })
}
