/**
 * Test doubles and filesystem helpers.
 *
 * The screenshot service is exercised against a *real* temporary filesystem with
 * a fake native backend: that keeps the PNG validation, filename uniquifying and
 * partial-file cleanup real while removing the dependency on a screen.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ScreenshotService, silentLogger } from '../../src/capture.js'
import { resolveConfig, type ScreenshotConfig } from '../../src/config.js'
import { ScreenshotError } from '../../src/errors.js'
import { createFileSystemOps, type FileSystemOps } from '../../src/storage.js'
import type {
  CaptureOutcome,
  CaptureScreenOptions,
  CaptureWindowOptions,
  DisplayInfo,
  ListTargetsOptions,
  ListTargetsResult,
  ScreenBackend,
  WindowInfo,
} from '../../src/platforms/types.js'
import { splitPng } from './png.js'

export interface TempDirectory {
  path: string
  cleanup(): Promise<void>
}

/** Create a unique directory under the OS temp area and remove it afterwards. */
export async function makeTempDirectory(prefix = 'dsh-screenshot-'): Promise<TempDirectory> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return {
    path: directory,
    async cleanup() {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

export interface CaptureBehaviour {
  /** PNG bytes handed back to the service. */
  png?: Buffer
  /** Written instead of `png` when set (for malformed output). */
  raw?: Buffer
  /** Skip writing a file entirely. */
  skipWrite?: boolean
  /** Thrown instead of capturing. */
  fail?: Error
  /** Reported dimensions override. */
  width?: number
  height?: number
  method?: CaptureOutcome['method']
  notes?: string[]
  display?: DisplayInfo
  window?: WindowInfo
}

export type CaptureHandler = (outPath: string) => Promise<CaptureBehaviour>

export interface FakeBackendOptions {
  screen?: CaptureHandler
  window?: CaptureHandler
  list?: () => Promise<ListTargetsResult>
  supportsDesktopWindowFallback?: boolean
}

export class FakeBackend implements ScreenBackend {
  readonly platform = 'win32' as const
  readonly displayName = 'fake backend'
  readonly supportsDesktopWindowFallback: boolean

  readonly calls: Array<{ operation: 'screen' | 'window' | 'list'; options: unknown }> = []

  #screen: CaptureHandler
  #window: CaptureHandler
  #list: () => Promise<ListTargetsResult>

  constructor(options: FakeBackendOptions = {}) {
    this.supportsDesktopWindowFallback = options.supportsDesktopWindowFallback ?? false
    // The default fixtures are two-toned on purpose: a uniform image would be
    // rejected as a blank capture before any other assertion ran.
    this.#screen =
      options.screen ??
      (async () => ({ png: splitPng(16, 9, { r: 10, g: 20, b: 30 }, { r: 240, g: 240, b: 240 }) }))
    this.#window =
      options.window ??
      (async () => ({ png: splitPng(12, 8, { r: 40, g: 50, b: 60 }, { r: 200, g: 30, b: 30 }) }))
    this.#list = options.list ?? (async () => ({ windows: [], displays: [], notes: [] }))
  }

  setScreenHandler(handler: CaptureHandler): void {
    this.#screen = handler
  }

  setWindowHandler(handler: CaptureHandler): void {
    this.#window = handler
  }

  async listTargets(options: ListTargetsOptions = {}): Promise<ListTargetsResult> {
    this.calls.push({ operation: 'list', options })
    return this.#list()
  }

  async captureScreen(options: CaptureScreenOptions): Promise<CaptureOutcome> {
    this.calls.push({ operation: 'screen', options })
    return applyBehaviour(options.outPath, await this.#screen(options.outPath), 'copyfromscreen')
  }

  async captureWindow(options: CaptureWindowOptions): Promise<CaptureOutcome> {
    this.calls.push({ operation: 'window', options })
    const behaviour = await this.#window(options.outPath)
    return applyBehaviour(
      options.outPath,
      behaviour,
      options.strategy === 'desktop' ? 'desktop-region' : 'printwindow',
    )
  }
}

async function applyBehaviour(
  outPath: string,
  behaviour: CaptureBehaviour,
  defaultMethod: CaptureOutcome['method'],
): Promise<CaptureOutcome> {
  if (behaviour.fail) throw behaviour.fail
  if (!behaviour.skipWrite) {
    await fs.writeFile(outPath, behaviour.raw ?? behaviour.png ?? Buffer.alloc(0))
  }
  return {
    ...(behaviour.width === undefined ? {} : { width: behaviour.width }),
    ...(behaviour.height === undefined ? {} : { height: behaviour.height }),
    ...(behaviour.display ? { display: behaviour.display } : {}),
    ...(behaviour.window ? { window: behaviour.window } : {}),
    method: behaviour.method ?? defaultMethod,
    notes: behaviour.notes ?? [],
  }
}

export interface TestServiceOptions {
  backend?: FakeBackend
  outputDir: string
  config?: Partial<ScreenshotConfig>
  ops?: FileSystemOps
  now?: () => Date
  random?: () => string
}

/** Deterministic sequence generator for filenames. */
export function sequenceRandom(prefix = 'token'): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `${prefix}${String(counter).padStart(4, '0')}`
  }
}

export function createTestService(options: TestServiceOptions): {
  service: ScreenshotService
  backend: FakeBackend
} {
  const backend = options.backend ?? new FakeBackend()
  const config = resolveConfig(
    { outputDir: options.outputDir, ...options.config },
    {},
  )
  const service = new ScreenshotService({
    backend,
    config,
    logger: silentLogger,
    ops: options.ops ?? createFileSystemOps(),
    now: options.now ?? (() => new Date('2026-10-27T12:00:00.000Z')),
    random: options.random ?? sequenceRandom(),
  })
  return { service, backend }
}

/** Wrap the real filesystem operations and override individual methods. */
export function wrapOps(
  base: FileSystemOps,
  overrides: Partial<FileSystemOps>,
): FileSystemOps {
  return { ...base, ...overrides }
}

export function makeDisplay(overrides: Partial<DisplayInfo> = {}): DisplayInfo {
  return {
    index: 0,
    id: '\\\\.\\DISPLAY1',
    name: 'DISPLAY1',
    primary: true,
    width: 1920,
    height: 1080,
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    ...overrides,
  }
}

export function makeWindow(overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    id: 'win32:4195478',
    title: 'Untitled window',
    app: 'someapp',
    pid: 1234,
    bounds: { x: 100, y: 80, width: 640, height: 480 },
    minimized: false,
    onScreen: true,
    foreground: false,
    ...overrides,
  }
}

/** Assert that a promise rejects with a plugin error of the given code. */
export async function expectScreenshotError(
  operation: Promise<unknown>,
  code: ScreenshotError['code'],
): Promise<ScreenshotError> {
  try {
    await operation
  } catch (error) {
    if (!(error instanceof ScreenshotError)) {
      throw new Error(`expected a ScreenshotError with code ${code}, received ${String(error)}`)
    }
    if (error.code !== code) {
      throw new Error(`expected code ${code}, received ${error.code}: ${error.message}`)
    }
    return error
  }
  throw new Error(`expected the operation to fail with ${code}, but it resolved`)
}

/** List the files in a directory, sorted, excluding hidden partial files. */
export async function listFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory)
  return entries.filter((entry) => !entry.startsWith('.')).sort()
}

/** Count the leftover `.partial` files in a directory. */
export async function countPartialFiles(directory: string): Promise<number> {
  const entries = await fs.readdir(directory)
  return entries.filter((entry) => entry.endsWith('.partial')).length
}
