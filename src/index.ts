/**
 * dsh-screenshot-master — cross-platform screenshot capture for DeepSeek Harness.
 *
 * Entry point for the Cordis plugin lifecycle:
 *   - resolve configuration from the plugin row and the environment,
 *   - pick the backend for the current operating system,
 *   - build the screenshot service,
 *   - register `screenshot_screen`, `list_windows` and `screenshot_window`.
 *
 * Starting the plugin never captures anything: registration is synchronous and
 * side-effect free, so nothing touches the screen until a tool is called.
 */

import { resolveConfig, type ScreenshotConfig } from './config.js'
import {
  createScreenshotService,
  silentLogger,
  type Logger,
  type ScreenshotService,
} from './capture.js'
import {
  SUPPORTED_PLATFORMS,
  createBackendForPlatform,
  isSupportedPlatform,
} from './platforms/index.js'
import { registerTools, type ToolRegistry } from './tools.js'

export const name = 'dsh-screenshot-master'

/** The only harness service this plugin needs. */
export const inject = ['tools']

/** Minimal shape of the Cordis context this plugin uses. */
export interface PluginContext {
  tools: ToolRegistry
  effect?(callback: () => (() => void) | void, label?: string): unknown
  logger?: unknown
}

export interface SetupOptions {
  /** Overrides `process.platform`; used by tests. */
  platform?: string
  /** Overrides the whole service; used by tests. */
  service?: ScreenshotService
}

export interface SetupResult {
  service: ScreenshotService
  config: ScreenshotConfig
  /** Unregisters every tool registered by this setup. */
  dispose: () => void
}

interface LoggerLike {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

/** Adapt the Cordis logger (or the absence of one) to the plugin's logger. */
export function createPluginLogger(ctx: PluginContext): Logger {
  let source: LoggerLike | undefined
  try {
    const candidate =
      typeof ctx.logger === 'function'
        ? (ctx.logger as (name: string) => unknown)(name)
        : ctx.logger
    if (candidate && typeof candidate === 'object') source = candidate as LoggerLike
  } catch {
    source = undefined
  }

  if (!source) return silentLogger

  return {
    info(message: string) {
      source?.info?.(message)
    },
    warn(message: string) {
      if (source?.warn) source.warn(message)
      else source?.info?.(message)
    },
  }
}

/**
 * Build the service and register the tools.
 *
 * Exported separately from `apply` so that the whole registration path can be
 * exercised without the Cordis lifecycle.
 */
export function setup(
  ctx: PluginContext,
  rawConfig: Record<string, unknown> = {},
  options: SetupOptions = {},
): SetupResult {
  if (!ctx || typeof ctx !== 'object' || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('dsh-screenshot-master: the plugin context has no tool registry (ctx.tools.register).')
  }

  const config = resolveConfig(rawConfig ?? {})
  const logger = createPluginLogger(ctx)
  const platform = options.platform ?? process.platform

  if (!isSupportedPlatform(platform)) {
    logger.warn(
      `screenshot capture is not supported on ${platform}; the tools are registered but every call will fail with UNSUPPORTED_PLATFORM. Supported platforms: ${SUPPORTED_PLATFORMS.join(', ')}.`,
    )
  }

  const service =
    options.service ??
    createScreenshotService({
      backend: createBackendForPlatform(config, platform),
      config,
      logger,
    })

  const dispose = registerTools({ tools: ctx.tools, service, logger })
  logger.info(
    `ready: platform=${platform}, backend=${service.backend.displayName}, outputDir=${config.outputDir}`,
  )

  return { service, config, dispose }
}

/**
 * Cordis entry point.
 *
 * The tool registrations are owned by `ctx.effect` so they are removed when the
 * plugin unloads or is hot-reloaded.
 */
export function apply(ctx: PluginContext, rawConfig: Record<string, unknown> = {}): void {
  const { dispose } = setup(ctx, rawConfig ?? {})

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-screenshot-master: tools')
    return
  }

  // Without a lifecycle hook the registrations simply live as long as the
  // process; this keeps the plugin usable in minimal hosts.
  void dispose
}

export { resolveConfig, type ScreenshotConfig } from './config.js'
export { ScreenshotError, type ScreenshotErrorCode } from './errors.js'
export { ScreenshotService, type ScreenshotResult, type ListedTargets } from './capture.js'
export { buildToolDefinitions, registerTools } from './tools.js'
export { decodePng, readPngHeader, analyzeImage } from './png.js'
export { createBackendForPlatform, SUPPORTED_PLATFORMS } from './platforms/index.js'
