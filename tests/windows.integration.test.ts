/**
 * Windows integration tests: these capture the real screen and real windows.
 *
 * They start real WinForms windows, enumerate them through the production
 * backend, and assert on the pixels that come back. Nothing here is mocked.
 *
 * The discriminating test is "captures a window without including the window
 * that overlaps it": fixture B is top-most and covers part of fixture A. A
 * capture of A's desktop rectangle would contain B's magenta body; a capture of
 * A's own content cannot.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScreenshotService } from '../src/capture.js'
import { resolveConfig } from '../src/config.js'
import { ScreenshotError } from '../src/errors.js'
import { analyzeImage, colorShare, decodePng } from '../src/png.js'
import { createFileSystemOps } from '../src/storage.js'
import { createWindowsBackend } from '../src/platforms/windows.js'
import type { WindowSummary } from '../src/capture.js'
import {
  countPartialFiles,
  expectScreenshotError,
  makeTempDirectory,
  type TempDirectory,
} from './helpers/fakes.js'

const FIXTURE_SCRIPT = fileURLToPath(new URL('./fixtures/fixture-window.ps1', import.meta.url))
const POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

const RUN_ID = `${process.pid}-${Date.now().toString(36)}`
const TITLE_A = `DSH Fixture A ${RUN_ID}`
const TITLE_B = `DSH Fixture B ${RUN_ID}`
const TITLE_CLOSED = `DSH Fixture Closed ${RUN_ID}`
const TITLE_MINIMIZED = `DSH Fixture Minimized ${RUN_ID}`

const GREEN = { r: 0, g: 128, b: 0 }
const MAGENTA = { r: 217, g: 27, b: 192 }
const WHITE = { r: 255, g: 255, b: 255 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe.skipIf(process.platform !== 'win32')('Windows real capture', () => {
  let temp: TempDirectory
  let service: ScreenshotService
  let windowA: WindowSummary
  let windowB: WindowSummary
  let windowMinimized: WindowSummary
  const children = new Set<ChildProcess>()

  function launchFixture(args: string[]): ChildProcess {
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', FIXTURE_SCRIPT, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false },
    )
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[fixture] ${chunk.toString()}`)
    })
    children.add(child)
    return child
  }

  async function stopFixture(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      children.delete(child)
      return
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill()
    await Promise.race([exited, sleep(5_000)])
    children.delete(child)
  }

  async function findWindow(title: string, timeoutMs = 30_000): Promise<WindowSummary> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const targets = await service.listWindows({ filter: title })
        const match = targets.windows.find((window) => window.title === title)
        if (match) return match
      } catch (error) {
        lastError = error
      }
      await sleep(250)
    }
    throw new Error(
      `fixture window ${JSON.stringify(title)} did not appear within ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ''}`,
    )
  }

  async function waitUntilGone(title: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const targets = await service.listWindows({ filter: title })
      if (!targets.windows.some((window) => window.title === title)) return
      await sleep(200)
    }
    throw new Error(`fixture window ${JSON.stringify(title)} is still enumerable after ${timeoutMs}ms`)
  }

  beforeAll(async () => {
    temp = await makeTempDirectory('dsh-shot-integration-')
    const config = resolveConfig({ outputDir: temp.path, timeoutMs: 60_000 }, {})
    service = new ScreenshotService({
      backend: createWindowsBackend({ timeoutMs: config.timeoutMs }),
      config,
      ops: createFileSystemOps(),
    })

    // A is the large green window; B is top-most and overlaps A's lower right.
    launchFixture(['-Title', TITLE_A, '-Color', '#008000', '-Width', '520', '-Height', '380', '-X', '60', '-Y', '100'])
    launchFixture(['-Title', TITLE_B, '-Color', '#D91BC0', '-Width', '280', '-Height', '220', '-X', '240', '-Y', '240', '-TopMost'])
    launchFixture(['-Title', TITLE_MINIMIZED, '-Color', '#1B4AD9', '-Width', '300', '-Height', '200', '-X', '900', '-Y', '500', '-Minimized'])

    windowA = await findWindow(TITLE_A)
    windowB = await findWindow(TITLE_B)
    windowMinimized = await findWindow(TITLE_MINIMIZED)

    console.log(
      `[integration] run ${RUN_ID}: A=${windowA.id} B=${windowB.id} minimized=${windowMinimized.id}`,
    )
  })

  afterAll(async () => {
    for (const child of [...children]) {
      await stopFixture(child)
    }
    await temp?.cleanup()
  })

  it('enumerates real displays and windows', async () => {
    const targets = await service.listWindows()
    expect(targets.displays.length).toBeGreaterThan(0)
    expect(targets.displays.some((display) => display.primary)).toBe(true)
    for (const display of targets.displays) {
      expect(display.width).toBeGreaterThan(0)
      expect(display.height).toBeGreaterThan(0)
    }

    const titles = new Set(targets.windows.map((window) => window.title))
    expect(titles.has(TITLE_A)).toBe(true)
    expect(titles.has(TITLE_B)).toBe(true)

    // Identifiers must be unique even though several windows are enumerated.
    const ids = targets.windows.map((window) => window.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('win32:'))).toBe(true)
    expect(targets.windows.every((window) => window.pid > 0)).toBe(true)
  })

  it('captures the full screen at the real display size', async () => {
    const targets = await service.listWindows()
    const primary = targets.displays.find((display) => display.primary) ?? targets.displays[0]!

    const result = await service.captureScreen()

    expect(result.captureType).toBe('screen')
    expect(result.method).toBe('copyfromscreen')
    expect(result.fallback).toBe(false)
    expect(result.width).toBe(primary.width)
    expect(result.height).toBe(primary.height)
    expect(result.display?.primary).toBe(true)

    const bytes = await fs.readFile(result.path)
    expect(bytes.length).toBeGreaterThan(1_000)
    const image = decodePng(bytes)
    expect(image.width).toBe(result.width)
    expect(image.height).toBe(result.height)

    // A desktop with windows on it is never a single colour.
    const stats = analyzeImage(image)
    expect(stats.uniform).toBe(false)
    expect(result.uniform).toBe(false)
  })

  it('captures an explicitly selected display', async () => {
    const targets = await service.listWindows()
    const primaryIndex = targets.displays.find((display) => display.primary)?.index ?? 0

    const result = await service.captureScreen({ display: primaryIndex })

    expect(result.display?.index).toBe(primaryIndex)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })

  it('reports an out-of-range display index', async () => {
    const targets = await service.listWindows()
    const invalid = targets.displays.length + 3
    await expectScreenshotError(service.captureScreen({ display: invalid }), 'DISPLAY_NOT_FOUND')
  })

  it('captures a window without including the window that overlaps it', async () => {
    // This is the test that separates a real window capture from a desktop crop.
    const result = await service.captureWindow({ windowId: windowA.id })

    expect(result.captureType).toBe('window')
    expect(result.method).toBe('printwindow')
    expect(result.fallback).toBe(false)
    expect(result.window?.id).toBe(windowA.id)
    expect(Math.abs(result.width - windowA.bounds.width)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.height - windowA.bounds.height)).toBeLessThanOrEqual(2)

    const image = decodePng(await fs.readFile(result.path))
    const green = colorShare(image, GREEN)
    const magenta = colorShare(image, MAGENTA)
    const white = colorShare(image, WHITE)

    expect(green).toBeGreaterThan(0.4)
    expect(white).toBeGreaterThan(0.05)
    // Fixture B covers part of A's rectangle; it must not be in A's pixels.
    expect(magenta).toBeLessThan(0.005)
    expect(analyzeImage(image).uniform).toBe(false)
  })

  it('captures a second window with its own content', async () => {
    const result = await service.captureWindow({ windowId: windowB.id })

    expect(result.window?.id).toBe(windowB.id)
    expect(result.fallback).toBe(false)
    expect(Math.abs(result.width - windowB.bounds.width)).toBeLessThanOrEqual(2)

    const image = decodePng(await fs.readFile(result.path))
    expect(colorShare(image, MAGENTA)).toBeGreaterThan(0.4)
    expect(colorShare(image, GREEN)).toBeLessThan(0.005)
  })

  it('writes a decodable, non-empty PNG whose dimensions match the result', async () => {
    const result = await service.captureWindow({ windowId: windowB.id })
    const stat = await fs.stat(result.path)
    expect(stat.size).toBe(result.bytes)
    expect(stat.size).toBeGreaterThan(500)
    const image = decodePng(await fs.readFile(result.path))
    expect(image.width).toBe(result.width)
    expect(image.height).toBe(result.height)
  })

  it('gives concurrent captures distinct files', async () => {
    const results = await Promise.all([
      service.captureScreen(),
      service.captureWindow({ windowId: windowA.id }),
      service.captureScreen(),
    ])
    expect(new Set(results.map((result) => result.fileName)).size).toBe(3)
    for (const result of results) {
      const image = decodePng(await fs.readFile(result.path))
      expect(image.width).toBe(result.width)
    }
  })

  it('reports a window that was closed instead of capturing something else', async () => {
    const child = launchFixture([
      '-Title',
      TITLE_CLOSED,
      '-Color',
      '#D9A21B',
      '-Width',
      '260',
      '-Height',
      '180',
      '-X',
      '700',
      '-Y',
      '300',
    ])
    const window = await findWindow(TITLE_CLOSED)
    await stopFixture(child)
    await waitUntilGone(TITLE_CLOSED)

    const error = await service.captureWindow({ windowId: window.id }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ScreenshotError)
    expect(['WINDOW_NOT_FOUND', 'WINDOW_NOT_CAPTURABLE']).toContain((error as ScreenshotError).code)
  })

  it('rejects a malformed window identifier', async () => {
    await expectScreenshotError(service.captureWindow({ windowId: 'bogus' }), 'INVALID_ARGUMENT')
    await expectScreenshotError(service.captureWindow({ windowId: 'win32:not-a-number' }), 'INVALID_ARGUMENT')
  })

  it('reports a window handle that does not exist', async () => {
    const error = await service.captureWindow({ windowId: 'win32:1' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ScreenshotError)
    expect(['WINDOW_NOT_FOUND', 'WINDOW_NOT_CAPTURABLE']).toContain((error as ScreenshotError).code)
  })

  it('never returns an unvalidated image for a minimized window', async () => {
    // Either the platform can capture it (and the PNG must be real content), or
    // the call must fail with an explicit code. Silently returning a blank or
    // substituted image is the failure this test guards against.
    try {
      const result = await service.captureWindow({ windowId: windowMinimized.id })
      const image = decodePng(await fs.readFile(result.path))
      expect(image.width).toBeGreaterThan(0)
      expect(image.height).toBeGreaterThan(0)
      expect(analyzeImage(image).uniform).toBe(false)
      console.log(`[integration] minimized window captured with ${result.method} (fallback=${result.fallback})`)
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenshotError)
      expect(['WINDOW_MINIMIZED', 'WINDOW_NOT_CAPTURABLE', 'BLANK_CAPTURE']).toContain(
        (error as ScreenshotError).code,
      )
      console.log(`[integration] minimized window refused with ${(error as ScreenshotError).code}`)
    }
  })

  it('leaves no partial files behind', async () => {
    expect(await countPartialFiles(temp.path)).toBe(0)
    const entries = await fs.readdir(temp.path)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((entry) => entry.endsWith('.png'))).toBe(true)
  })
})
