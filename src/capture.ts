/**
 * The shared screenshot service.
 *
 * Responsibilities:
 *   - validate arguments before a native call is made,
 *   - drive the platform backend into a partial file,
 *   - prove the result is a real, non-empty, decodable, non-blank PNG,
 *   - retry through the documented fallback when a window capture yields nothing,
 *   - commit the bytes to a unique final path and clean up the partial file.
 *
 * Everything platform specific lives behind `ScreenBackend`; everything about
 * files lives behind `FileSystemOps`. Both are injected so the orchestration can
 * be tested deterministically on any operating system.
 */

import path from 'node:path'
import { resolveConfig, type ScreenshotConfig } from './config.js'
import { ScreenshotError, toScreenshotError, isScreenshotError } from './errors.js'
import { analyzeImage, decodePng, readPngHeader, type ImageStatistics } from './png.js'
import {
  commitScreenshot,
  createFileSystemOps,
  discardPartial,
  ensureDirectory,
  partialPath,
  randomToken,
  type FileSystemOps,
} from './storage.js'
import type {
  CaptureMethod,
  CaptureOutcome,
  DisplayInfo,
  ScreenBackend,
  WindowInfo,
} from './platforms/types.js'

export interface Logger {
  info(message: string): void
  warn(message: string): void
}

export const silentLogger: Logger = { info: () => {}, warn: () => {} }

export interface DisplaySummary {
  index: number
  id: string
  name: string
  primary: boolean
  width: number
  height: number
  scaleFactor: number
}

export interface WindowSummary {
  id: string
  title: string
  app: string
  pid: number
  bounds: { x: number; y: number; width: number; height: number }
  displayIndex?: number
}

export interface ScreenshotResult {
  /** Absolute path of the saved PNG. */
  path: string
  fileName: string
  bytes: number
  width: number
  height: number
  captureType: 'screen' | 'window'
  method: CaptureMethod
  /** ISO-8601 timestamp taken before the native call started. */
  takenAt: string
  /** True only when the whole image is one colour (accepted by configuration). */
  uniform: boolean
  /** True when a fallback mechanism produced the image. */
  fallback: boolean
  notes: string[]
  display?: DisplaySummary
  window?: WindowSummary
}

export interface ListedTargets {
  count: number
  windows: WindowSummary[]
  displays: DisplaySummary[]
  notes: string[]
}

export interface ScreenshotServiceOptions {
  backend: ScreenBackend
  config?: ScreenshotConfig
  logger?: Logger
  ops?: FileSystemOps
  now?: () => Date
  random?: () => string
}

export interface CaptureScreenRequest {
  display?: number | string | undefined
  signal?: AbortSignal | undefined
}

export interface CaptureWindowRequest {
  windowId: string
  /** Override the configured desktop-region fallback for this call. */
  allowFallback?: boolean | undefined
  signal?: AbortSignal | undefined
}

export interface ListWindowsRequest {
  filter?: string | undefined
  signal?: AbortSignal | undefined
}

const MAX_WINDOW_ID_LENGTH = 200

/** Reject an identifier that cannot possibly name a window before spawning anything. */
export function validateWindowId(windowId: unknown): string {
  if (typeof windowId !== 'string' || windowId.trim().length === 0) {
    throw new ScreenshotError('INVALID_ARGUMENT', '`window_id` is required and must be a non-empty string.', {
      hint: 'Call list_windows and pass one of the returned `id` values.',
    })
  }
  const value = windowId.trim()
  if (value.length > MAX_WINDOW_ID_LENGTH) {
    throw new ScreenshotError('INVALID_ARGUMENT', `\`window_id\` is longer than ${MAX_WINDOW_ID_LENGTH} characters.`, {
      hint: 'Pass an identifier exactly as list_windows returned it.',
    })
  }
  // Control characters and path separators never appear in a real identifier and
  // would only be an attempt to confuse the native command line.
  // eslint-disable-next-line no-control-regex -- detecting control characters is the point
  if (/[\u0000-\u001f\u007f/\\]/.test(value)) {
    throw new ScreenshotError('INVALID_ARGUMENT', '`window_id` contains characters that are not allowed.', {
      hint: 'Pass an identifier exactly as list_windows returned it.',
    })
  }
  return value
}

export function validateFilter(filter: unknown): string | undefined {
  if (filter === undefined || filter === null) return undefined
  if (typeof filter !== 'string') {
    throw new ScreenshotError('INVALID_ARGUMENT', '`filter` must be a string when provided.')
  }
  const value = filter.trim()
  return value.length === 0 ? undefined : value
}

export function validateDisplay(display: unknown): number | string | undefined {
  if (display === undefined || display === null) return undefined
  if (typeof display === 'number') {
    if (!Number.isInteger(display) || display < 0) {
      throw new ScreenshotError('INVALID_ARGUMENT', `\`display\` must be a zero-based integer, received ${display}.`, {
        hint: 'Call list_windows to see the available display indices.',
      })
    }
    return display
  }
  if (typeof display === 'string') {
    const value = display.trim()
    if (!value) throw new ScreenshotError('INVALID_ARGUMENT', '`display` must not be an empty string.')
    return /^\d+$/.test(value) ? Number(value) : value
  }
  throw new ScreenshotError('INVALID_ARGUMENT', '`display` must be an integer index or a display identifier string.')
}

function windowMatches(window: WindowInfo, filter: string): boolean {
  const needle = filter.toLowerCase()
  return (
    window.title.toLowerCase().includes(needle) ||
    window.app.toLowerCase().includes(needle) ||
    window.id.toLowerCase().includes(needle)
  )
}

function toDisplaySummary(display: DisplayInfo): DisplaySummary {
  return {
    index: display.index,
    id: display.id,
    name: display.name,
    primary: display.primary,
    width: display.width,
    height: display.height,
    scaleFactor: display.scaleFactor,
  }
}

function toWindowSummary(window: WindowInfo): WindowSummary {
  return {
    id: window.id,
    title: window.title,
    app: window.app,
    pid: window.pid,
    bounds: window.bounds,
    ...(window.displayIndex === undefined ? {} : { displayIndex: window.displayIndex }),
  }
}

export class ScreenshotService {
  readonly #backend: ScreenBackend
  readonly #config: ScreenshotConfig
  readonly #logger: Logger
  readonly #ops: FileSystemOps
  readonly #now: () => Date
  readonly #random: () => string

  constructor(options: ScreenshotServiceOptions) {
    this.#backend = options.backend
    this.#config = options.config ?? resolveConfig()
    this.#logger = options.logger ?? silentLogger
    this.#ops = options.ops ?? createFileSystemOps()
    this.#now = options.now ?? (() => new Date())
    this.#random = options.random ?? (() => randomToken(6))
  }

  get config(): ScreenshotConfig {
    return this.#config
  }

  get backend(): ScreenBackend {
    return this.#backend
  }

  /** Enumerate capture targets. Never captures an image. */
  async listWindows(request: ListWindowsRequest = {}): Promise<ListedTargets> {
    const filter = validateFilter(request.filter)
    const targets = await this.#backend.listTargets(
      request.signal ? { signal: request.signal } : {},
    )

    const windows = (filter ? targets.windows.filter((window) => windowMatches(window, filter)) : targets.windows)
      .map(toWindowSummary)
    const notes = [...targets.notes]

    if (targets.windows.length === 0) {
      notes.push('The platform reported no capturable windows.')
    } else if (windows.length === 0) {
      notes.push(`No window matched the filter ${JSON.stringify(filter ?? '')}.`)
    }

    return {
      count: windows.length,
      windows,
      displays: targets.displays.map(toDisplaySummary),
      notes,
    }
  }

  /** Capture the whole screen, or one display of it. */
  async captureScreen(request: CaptureScreenRequest = {}): Promise<ScreenshotResult> {
    const display = validateDisplay(request.display)
    const outputDir = this.#config.outputDir
    await ensureDirectory(outputDir, this.#ops)

    const at = this.#now()
    const temp = partialPath(outputDir, this.#random())

    try {
      this.#logger.info(
        `capturing screen${display === undefined ? ' (primary display)' : ` display=${String(display)}`} -> ${outputDir}`,
      )
      const outcome = await this.#backend.captureScreen({
        ...(display === undefined ? {} : { display }),
        outPath: temp,
        ...(request.signal ? { signal: request.signal } : {}),
      })
      const validated = await this.#validate(temp)
      this.#assertReportedDimensions(outcome, validated.stats)

      const committed = await commitScreenshot({
        outputDir,
        kind: 'screen',
        label: outcome.display ? `display${outcome.display.index}` : undefined,
        data: validated.data,
        at,
        random: this.#random,
        ops: this.#ops,
      })

      return {
        path: committed.absolutePath,
        fileName: committed.fileName,
        bytes: committed.bytes,
        width: validated.stats.width,
        height: validated.stats.height,
        captureType: 'screen',
        method: outcome.method,
        takenAt: at.toISOString(),
        uniform: validated.stats.uniform,
        fallback: outcome.fallback === true,
        notes: [...outcome.notes],
        ...(outcome.display ? { display: toDisplaySummary(outcome.display) } : {}),
      }
    } catch (error) {
      throw await this.#fail(error, 'screen capture')
    } finally {
      await this.#cleanup(temp)
    }
  }

  /**
   * Capture one window.
   *
   * A window capture that yields an unusable image is retried through the
   * desktop-region strategy only when the backend offers it and the failure is
   * one a rectangle capture can plausibly fix. A missing window is never
   * retried: the rectangle would be garbage or would belong to another window.
   */
  async captureWindow(request: CaptureWindowRequest): Promise<ScreenshotResult> {
    const windowId = validateWindowId(request.windowId)
    const outputDir = this.#config.outputDir
    await ensureDirectory(outputDir, this.#ops)

    const at = this.#now()
    const temp = partialPath(outputDir, this.#random())
    const allowFallback = request.allowFallback ?? this.#config.windowFallback

    try {
      this.#logger.info(`capturing window ${windowId} -> ${outputDir}`)

      try {
        const outcome = await this.#backend.captureWindow({
          windowId,
          outPath: temp,
          strategy: 'native',
          ...(request.signal ? { signal: request.signal } : {}),
        })
        const validated = await this.#validate(temp)
        this.#assertReportedDimensions(outcome, validated.stats)
        const committed = await commitScreenshot({
          outputDir,
          kind: 'window',
          label: outcome.window?.title || outcome.window?.app || windowId,
          data: validated.data,
          at,
          random: this.#random,
          ops: this.#ops,
        })

        return {
          path: committed.absolutePath,
          fileName: committed.fileName,
          bytes: committed.bytes,
          width: validated.stats.width,
          height: validated.stats.height,
          captureType: 'window',
          method: outcome.method,
          takenAt: at.toISOString(),
          uniform: validated.stats.uniform,
          fallback: outcome.fallback === true,
          notes: [...outcome.notes],
          ...(outcome.window ? { window: toWindowSummary(outcome.window) } : {}),
        }
      } catch (error) {
        const primary = toScreenshotError(error, 'CAPTURE_FAILED')
        const retryable =
          allowFallback &&
          this.#backend.supportsDesktopWindowFallback &&
          (primary.code === 'BLANK_CAPTURE' ||
            primary.code === 'WINDOW_NOT_CAPTURABLE' ||
            primary.code === 'CAPTURE_FAILED')

        if (!retryable) throw primary

        this.#logger.warn(
          `window ${windowId} could not be captured natively (${primary.code}); retrying with the desktop region`,
        )
        await discardPartial(temp, this.#ops)

        const fallbackOutcome = await this.#backend.captureWindow({
          windowId,
          outPath: temp,
          strategy: 'desktop',
          ...(request.signal ? { signal: request.signal } : {}),
        })
        const validated = await this.#validate(temp)
        this.#assertReportedDimensions(fallbackOutcome, validated.stats)
        const committed = await commitScreenshot({
          outputDir,
          kind: 'window',
          label: fallbackOutcome.window?.title || fallbackOutcome.window?.app || windowId,
          data: validated.data,
          at,
          random: this.#random,
          ops: this.#ops,
        })

        return {
          path: committed.absolutePath,
          fileName: committed.fileName,
          bytes: committed.bytes,
          width: validated.stats.width,
          height: validated.stats.height,
          captureType: 'window',
          method: fallbackOutcome.method,
          takenAt: at.toISOString(),
          uniform: validated.stats.uniform,
          fallback: true,
          notes: [
            `Native window capture failed (${primary.code}: ${primary.message}).`,
            'The image was produced by capturing the window rectangle from the desktop; other windows overlapping it are included.',
            ...fallbackOutcome.notes,
          ],
          ...(fallbackOutcome.window ? { window: toWindowSummary(fallbackOutcome.window) } : {}),
        }
      }
    } catch (error) {
      throw await this.#fail(error, 'window capture')
    } finally {
      await this.#cleanup(temp)
    }
  }

  /**
   * Read the produced file and prove it is a real image.
   *
   * Throws `CAPTURE_FAILED` for a missing/empty file, `INVALID_PNG` when it does
   * not decode, and `BLANK_CAPTURE` when every pixel is identical (the signature
   * of a failed `PrintWindow` or a denied Screen Recording permission).
   */
  async #validate(temp: string): Promise<{ data: Buffer; stats: ImageStatistics }> {
    const { readFile } = this.#ops
    let data: Buffer
    try {
      data = await readFile(temp)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ScreenshotError('CAPTURE_FAILED', `The native capture reported success but wrote no file: ${temp}`, {
          hint: 'The platform capture API returned no image. Try another capture target or check the native logs.',
          cause: error,
        })
      }
      throw toScreenshotError(error, 'CAPTURE_FAILED')
    }

    if (data.length === 0) {
      throw new ScreenshotError('INVALID_PNG', `The native capture wrote an empty file: ${temp}`, {
        hint: 'The capture produced no data; retry or choose another target.',
      })
    }

    const header = readPngHeader(data)
    const image = decodePng(data)
    if (image.width !== header.width || image.height !== header.height) {
      throw new ScreenshotError('INVALID_PNG', 'The decoded PNG dimensions disagree with its header.')
    }

    const stats = analyzeImage(image)
    if (stats.uniform && !this.#config.allowUniformCaptures) {
      throw new ScreenshotError(
        'BLANK_CAPTURE',
        `The captured image is a single uniform colour (${stats.width}x${stats.height}), which means the capture produced no content.`,
        {
          hint:
            'The window may be protected, hardware-accelerated, minimized, or hidden. On macOS, grant Screen Recording permission to the Harness app. Set `allowUniformCaptures` to true if a genuinely uniform image is expected.',
          details: { dominantColor: stats.dominantColor, meanLuminance: stats.meanLuminance },
        },
      )
    }

    return { data, stats }
  }

  /**
   * Trust but verify: when a backend reports pixel dimensions, they must match
   * the file it produced. A mismatch means a stale or wrong file was read.
   */
  #assertReportedDimensions(outcome: CaptureOutcome, stats: ImageStatistics): void {
    if (!outcome.width || !outcome.height) return
    if (outcome.width !== stats.width || outcome.height !== stats.height) {
      throw new ScreenshotError(
        'CAPTURE_FAILED',
        `The native layer reported ${outcome.width}x${outcome.height} but the PNG decodes to ${stats.width}x${stats.height}.`,
        { hint: 'The capture wrote an unexpected file. Retry the capture.' },
      )
    }
  }

  async #fail(error: unknown, what: string): Promise<ScreenshotError> {
    if (isScreenshotError(error)) return error
    const normalized = toScreenshotError(error, 'CAPTURE_FAILED')
    this.#logger.warn(`${what} failed: ${normalized.message}`)
    if (normalized.code === 'INTERNAL_ERROR') {
      return new ScreenshotError('CAPTURE_FAILED', `${what} failed: ${normalized.message}`, {
        cause: error,
      })
    }
    return normalized
  }

  async #cleanup(temp: string): Promise<void> {
    if (this.#config.keepTempFiles) return
    try {
      await discardPartial(temp, this.#ops)
    } catch (error) {
      this.#logger.warn(`could not remove the partial file ${path.basename(temp)}: ${String(error)}`)
    }
  }
}

/** Convenience factory used by the plugin entry point. */
export function createScreenshotService(options: ScreenshotServiceOptions): ScreenshotService {
  return new ScreenshotService(options)
}
