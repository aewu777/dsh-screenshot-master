/**
 * The three tools the plugin registers.
 *
 * Scope reminder enforced by these definitions: the tools only capture and save.
 * They never open, display, analyse, OCR, attach, upload or transmit an image,
 * and they never delete a previously saved screenshot. The caller decides what
 * happens to the file afterwards.
 */

import type { ScreenshotService, ListedTargets, ScreenshotResult, Logger } from './capture.js'
import { ScreenshotError, toScreenshotError } from './errors.js'
import {
  defineTool,
  type JsonSchemaNode,
  type ToolDefinition,
  type ToolRunContext,
} from './toolkit.js'

/** The slice of the tool registry this plugin uses. */
export interface ToolRegistry {
  register(definition: ToolDefinition): () => void
}

export interface RegisterToolsOptions {
  tools: ToolRegistry
  service: ScreenshotService
  logger?: Logger
}

const BOUNDS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
  required: ['x', 'y', 'width', 'height'],
}

const DISPLAY_SUMMARY_SCHEMA: JsonSchemaNode = {
  type: 'object',
  description: 'The display that was captured.',
  properties: {
    index: { type: 'number', description: 'Zero-based display index.' },
    id: { type: 'string', description: 'Native display identifier.' },
    name: { type: 'string' },
    primary: { type: 'boolean' },
    width: { type: 'number', description: 'Width in pixels.' },
    height: { type: 'number', description: 'Height in pixels.' },
    scaleFactor: { type: 'number' },
  },
  required: ['index', 'id', 'width', 'height'],
}

const WINDOW_SUMMARY_SCHEMA: JsonSchemaNode = {
  type: 'object',
  description: 'The window that was captured.',
  properties: {
    id: { type: 'string', description: 'Identifier accepted by screenshot_window.' },
    title: { type: 'string' },
    app: { type: 'string', description: 'Owning application or process name.' },
    pid: { type: 'number' },
    bounds: BOUNDS_SCHEMA,
    displayIndex: { type: 'number' },
  },
  required: ['id', 'title', 'app', 'pid', 'bounds'],
}

const CAPTURE_RESULT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path of the saved PNG file.' },
    fileName: { type: 'string' },
    bytes: { type: 'number', description: 'Size of the saved file in bytes.' },
    width: { type: 'number', description: 'Decoded image width in pixels.' },
    height: { type: 'number', description: 'Decoded image height in pixels.' },
    captureType: { type: 'string', enum: ['screen', 'window'] },
    method: {
      type: 'string',
      description: 'Native mechanism that produced the image.',
      enum: [
        'copyfromscreen',
        'printwindow',
        'bitblt',
        'desktop-region',
        'screencapturekit',
        'screencapture-cli',
      ],
    },
    takenAt: { type: 'string', description: 'ISO-8601 timestamp of the capture.' },
    uniform: { type: 'boolean', description: 'True when the image is a single colour.' },
    fallback: { type: 'boolean', description: 'True when a fallback mechanism was used.' },
    notes: { type: 'array', items: { type: 'string' } },
    display: DISPLAY_SUMMARY_SCHEMA,
    window: WINDOW_SUMMARY_SCHEMA,
  },
  required: ['path', 'fileName', 'bytes', 'width', 'height', 'captureType', 'method', 'takenAt'],
}

const LIST_RESULT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    count: { type: 'number', description: 'Number of windows returned.' },
    windows: {
      type: 'array',
      items: WINDOW_SUMMARY_SCHEMA,
    },
    displays: {
      type: 'array',
      items: DISPLAY_SUMMARY_SCHEMA,
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['count', 'windows', 'displays'],
}

const WINDOW_ID_SCHEMA: JsonSchemaNode = {
  type: 'string',
  description:
    "The window `id` returned by list_windows, for example 'win32:4195478' (Windows) or 'mac:12345' (macOS). Never a window title.",
}

/** Re-throw a failure with the actionable hint attached to the message. */
function asToolFailure(error: unknown): ScreenshotError {
  const normalized = toScreenshotError(error)
  return new ScreenshotError(normalized.code, normalized.toMessage(), {
    ...(normalized.details ? { details: normalized.details } : {}),
    cause: normalized,
  })
}

export function formatCaptureResult(result: ScreenshotResult): string {
  const lines: string[] = []
  const label = result.captureType === 'window' ? 'window' : 'screen'
  lines.push(`Saved ${label} screenshot to ${result.path}`)
  lines.push(`  dimensions: ${result.width}x${result.height} px`)
  lines.push(`  method:     ${result.method}${result.fallback ? ' (fallback)' : ''}`)
  lines.push(`  bytes:      ${result.bytes}`)
  lines.push(`  taken at:   ${result.takenAt}`)
  if (result.display) {
    lines.push(
      `  display:    index ${result.display.index} (${result.display.name})${result.display.primary ? ', primary' : ''}`,
    )
  }
  if (result.window) {
    const title = result.window.title || '(untitled)'
    lines.push(`  window:     ${title} — ${result.window.app} (pid ${result.window.pid})`)
    lines.push(`  window id:  ${result.window.id}`)
  }
  if (result.uniform) {
    lines.push('  note:       the image is a single uniform colour.')
  }
  for (const note of result.notes ?? []) {
    lines.push(`  note:       ${note}`)
  }
  return lines.join('\n')
}

export function formatTargetList(result: ListedTargets): string {
  const lines: string[] = []
  const displays = result.displays ?? []
  const windows = result.windows ?? []

  lines.push(`Displays (${displays.length}):`)
  if (displays.length === 0) {
    lines.push('  (none reported)')
  } else {
    for (const display of displays) {
      lines.push(
        `  [${display.index}] ${display.name}  ${display.width}x${display.height}px  scale ${display.scaleFactor}${display.primary ? '  primary' : ''}`,
      )
    }
  }

  lines.push('')
  lines.push(`Windows (${result.count ?? windows.length}):`)
  if (windows.length === 0) {
    lines.push('  (none reported)')
  } else {
    for (const window of windows) {
      const title = window.title || '(untitled)'
      const flags = [
        window.displayIndex === undefined ? null : `display ${window.displayIndex}`,
        `${window.bounds?.width ?? '?'}x${window.bounds?.height ?? '?'}`,
      ].filter(Boolean)
      lines.push(`  ${window.id}  "${title}"  — ${window.app} (pid ${window.pid})  ${flags.join(', ')}`)
    }
  }

  if ((result.notes ?? []).length > 0) {
    lines.push('')
    for (const note of result.notes ?? []) lines.push(`note: ${note}`)
  }
  return lines.join('\n')
}

export function buildToolDefinitions(service: ScreenshotService): ToolDefinition[] {
  const captureScreen = defineTool({
    name: 'screenshot_screen',
    description:
      'Capture the full screen, or one selected display, and save it as a PNG file. Returns the absolute path of the saved file with its pixel dimensions and capture metadata. The image is only written to disk: it is not opened, analysed, uploaded, attached to the conversation, or transmitted anywhere.',
    parameters: {
      type: 'object',
      properties: {
        display: {
          oneOf: [{ type: 'integer' }, { type: 'string' }],
          description:
            'Optional display selector: a zero-based display index, or a display identifier as reported by list_windows. Omit it to capture the primary display.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: CAPTURE_RESULT_SCHEMA,
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolRunContext) {
      try {
        return await service.captureScreen({
          ...(args.display === undefined || args.display === null ? {} : { display: args.display as number | string }),
          ...(exec.signal ? { signal: exec.signal } : {}),
        })
      } catch (error) {
        throw asToolFailure(error)
      }
    },
    render(value) {
      return formatCaptureResult(value as ScreenshotResult)
    },
  })

  const listWindows = defineTool({
    name: 'list_windows',
    description:
      'List the application windows and displays available for capture on this machine. Use the returned window `id` — never the title, which is not unique — as the argument of screenshot_window. Optional `filter` narrows the result to windows whose title, application name or identifier contains the given text. This tool never captures an image.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            'Optional case-insensitive substring matched against the window title, the application name and the identifier.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: LIST_RESULT_SCHEMA,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolRunContext) {
      try {
        return await service.listWindows({
          ...(args.filter === undefined || args.filter === null ? {} : { filter: String(args.filter) }),
          ...(exec.signal ? { signal: exec.signal } : {}),
        })
      } catch (error) {
        throw asToolFailure(error)
      }
    },
    render(value) {
      return formatTargetList(value as ListedTargets)
    },
  })

  const captureWindow = defineTool({
    name: 'screenshot_window',
    description:
      'Capture one application window and save it as a PNG file. Pass the `id` returned by list_windows: window titles are not unique, so titles are not accepted. Captures the window\'s own content rather than the desktop area behind it; if the platform cannot read the window, an explicit error is returned instead of a substitute image. The file is only written to disk and is never opened, analysed, uploaded or attached.',
    parameters: {
      type: 'object',
      properties: {
        window_id: WINDOW_ID_SCHEMA,
      },
      required: ['window_id'],
      additionalProperties: false,
    },
    outputSchema: CAPTURE_RESULT_SCHEMA,
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext) {
      try {
        return await service.captureWindow({
          windowId: String(args.window_id ?? ''),
          ...(exec.signal ? { signal: exec.signal } : {}),
        })
      } catch (error) {
        throw asToolFailure(error)
      }
    },
    render(value) {
      return formatCaptureResult(value as ScreenshotResult)
    },
  })

  return [captureScreen, listWindows, captureWindow]
}

/**
 * Register every tool with the harness and return one disposer.
 *
 * Registration is synchronous and performs no capture, so plugin start-up stays
 * cheap and never touches the screen.
 */
export function registerTools(options: RegisterToolsOptions): () => void {
  const { tools, service } = options
  const disposers: Array<() => void> = []

  for (const definition of buildToolDefinitions(service)) {
    const dispose = tools.register(definition)
    disposers.push(dispose)
    options.logger?.info(`registered tool ${definition.name}`)
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Disposal errors must not prevent the remaining tools unloading.
      }
    }
  }
}
